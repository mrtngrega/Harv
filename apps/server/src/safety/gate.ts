import { existsSync, readFileSync, statSync } from 'node:fs';
import type { HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalRequest, QuestionItem, SafetyServerMessage } from '@harv/shared';
import type { ActionStore } from '../store/actions.ts';
import { createBackup, readBackup, restoreBackup, type Backup } from './backup.ts';
import {
  AGENT_TOOLS,
  askedToSend,
  classify,
  FILE_WRITE_TOOLS,
  isSending,
  READ_TOOLS,
  rulesFor,
  SHELL_TOOLS,
  TERMINAL_RUN,
  type ClassifyContext,
  type Verdict,
} from './classify.ts';
import { IS_WINDOWS } from '../platform.ts';
import { fullPath, isInside, loadSettings, PLANS_DIR, WORKSPACE } from './paths.ts';

/** How Harv's own folder is named to the model in a block message. */
const HARV_HOME_HINT = 'the .harv folder';

/** Harv's own tools that only look or note things: fine in plan mode. */
const PLAN_SAFE_HARV = ['remember', 'forget', 'list_chats', 'read_chat', 'list_projects', 'list_scheduled', 'terminal_read'].map(
  (t) => `mcp__harv__${t}`,
);

// Every tool call passes through here (Agent SDK hooks, so it can't be skipped):
//   green   → run
//   yellow  → back up, run, verify, log with Undo
//   red     → safety check + exact preview, back up, ask the user, run, verify, log
//   blocked → refuse with the reason

export interface GateHooks {
  broadcast: (msg: SafetyServerMessage) => void;
  /** A line in the chat tab (stored in its history). */
  notice: (tabId: string, message: string) => void;
  /** The number of waiting approvals changed (Harv's status shows "waiting"). */
  onChange: () => void;
  /** The project folder a chat works in (project mode trusts it), if any. */
  projectOf?: (tabId: string) => string | undefined;
  /** Every registered project folder: trusted from any chat, not only project chats. */
  projects?: () => string[];
  /** Files and folders on the PC the user attached to a chat: trusted in that chat. */
  attachedOf?: (tabId: string) => string[];
  /** "Don't ask again": save these rules (Settings › Safety). */
  allow?: (rules: string[]) => void;
  /** A chat went into plan mode (Claude's EnterPlanMode, /plan) or out of it (the user approved the plan). */
  onPlanMode?: (tabId: string, on: boolean) => void;
}

type Decision = {
  approve: boolean;
  command?: string;
  why?: string;
  always?: boolean;
  all?: boolean;
  answers?: Record<string, string>;
};

const allow = (updatedInput?: Record<string, unknown>): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(updatedInput ? { updatedInput } : {}) },
});

/** Claude's questions from an AskUserQuestion call, cleaned (the card shows only what's well-formed). */
function questionsOf(input: Record<string, unknown>): QuestionItem[] {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return raw
    .filter((q) => q && typeof q.question === 'string')
    .map((q) => ({
      question: String(q.question),
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : [])
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({
          label: String(o.label),
          description: typeof o.description === 'string' ? o.description : '',
          ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
        })),
    }));
}

/** The plan an ExitPlanMode call presents: in its input, or in the plan file Claude Code wrote. */
function planOf(input: Record<string, unknown>): string {
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan.trim();
  const file = typeof input.planFilePath === 'string' ? input.planFilePath : '';
  try {
    return file && existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

const MAX_RESULT = 300;

function describeSize(path: string): string {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 'does not exist';
  if (!st.isDirectory()) return st.size < 1024 ? `file, ${st.size} B` : `file, ${Math.round(st.size / 1024)} KB`;
  return 'folder';
}

/** Exactly what a red action will touch, for the approval card. */
function buildPreview(tool: string, input: Record<string, unknown>, verdict: Verdict): string {
  const lines: string[] = [];
  if (SHELL_TOOLS.includes(tool)) {
    lines.push(`${tool === 'PowerShell' || (tool === TERMINAL_RUN && IS_WINDOWS) ? 'PS>' : '$'} ${String(input.command ?? '')}`);
  } else if (tool === 'Write') {
    const content = String(input.content ?? '');
    lines.push(`write ${String(input.file_path)} (${content.length} characters):`, ...content.split(/\r?\n/).slice(0, 15));
  } else if (tool === 'Edit') {
    const cut = (s: unknown) =>
      String(s ?? '')
        .split(/\r?\n/)
        .slice(0, 8);
    lines.push(
      `edit ${String(input.file_path)}:`,
      ...cut(input.old_string).map((l) => `- ${l}`),
      ...cut(input.new_string).map((l) => `+ ${l}`),
    );
  }
  if (verdict.targets.length) {
    lines.push('', 'Affects:', ...verdict.targets.map((p) => `  ${p} (${describeSize(p)})`));
  }
  const protectedCount = loadSettings().protectedPaths.length;
  lines.push(
    '',
    protectedCount ? `Checked against your ${protectedCount} read-only folder(s): none touched.` : 'No read-only folders set.',
  );
  return lines.join('\n');
}

/** What Harv is told when Stop cancels a waiting approval (it once read these as refusals and gave up). */
const STOPPED =
  'The user pressed Stop, which interrupts the whole reply. It is not a refusal of this action: if they then ask you to continue, you may run it again.';

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

export class SafetyGate {
  private pending = new Map<string, { approval: ApprovalRequest; resolve: (d: Decision) => void }>();
  /** Red calls the user approved; canUseTool double-checks against this. */
  private approved = new Set<string>();
  private backups = new Map<string, Backup>();
  /** Tabs where the user chose "Approve all for this reply": their red calls run without a card until the turn ends. */
  private trustedTurns = new Set<string>();
  /** What the user asked for in each chat's current turn: the sending check reads it. */
  private turnText = new Map<string, string>();
  /** Chats in plan mode: only reading and planning until the user approves the plan. */
  private planning = new Set<string>();

  constructor(
    private actions: ActionStore,
    private hooks: GateHooks,
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  approvals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  private publish(id: string) {
    const action = this.actions.get(id);
    if (action && action.tier !== 'green') this.hooks.broadcast({ type: 'action', action });
  }

  private backup(id: string, targets: string[]): Backup | null {
    if (targets.length === 0) return null;
    const backup = createBackup(id, targets);
    if (backup.entries.length === 0) return backup;
    this.backups.set(id, backup);
    this.actions.update(id, { backupDir: backup.dir, backups: backup.entries.map((e) => e.original) });
    return backup;
  }

  /** What a chat's calls are classified with: its project, every project, and what the user attached to it. */
  private contextOf(tabId: string): ClassifyContext {
    return { project: this.hooks.projectOf?.(tabId), projects: this.hooks.projects?.(), attached: this.hooks.attachedOf?.(tabId) };
  }

  /** A new turn starts in a chat with this message (from the user, another chat or a scheduled task). */
  setTurn(tabId: string, text: string): void {
    this.turnText.set(tabId, text);
  }

  isPlanning(tabId: string): boolean {
    return this.planning.has(tabId);
  }

  /** Plan mode on or off (the /plan toggle, Claude's EnterPlanMode, or an approved plan). */
  setPlanning(tabId: string, on: boolean): void {
    if (on === this.planning.has(tabId)) return;
    if (on) this.planning.add(tabId);
    else this.planning.delete(tabId);
    this.hooks.onPlanMode?.(tabId, on);
  }

  /** What plan mode lets through: reading, planning, asking, and writing the plan file. */
  private planSafe(tool: string, input: Record<string, unknown>, verdict: Verdict): boolean {
    if (READ_TOOLS.includes(tool) || AGENT_TOOLS.includes(tool) || PLAN_SAFE_HARV.includes(tool)) return true;
    if (FILE_WRITE_TOOLS.includes(tool)) return isInside(fullPath(String(input.file_path ?? '')), PLANS_DIR);
    if (SHELL_TOOLS.includes(tool)) return verdict.tier === 'green';
    return (
      tool.startsWith('mcp__') && !tool.startsWith('mcp__harv__') && verdict.tier === 'green' && verdict.reason.startsWith('Only reads')
    );
  }

  /** The PreToolUse hook. Red calls wait here until the user answers the approval card. */
  async preToolUse(tabId: string, tool: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    if (tool === 'AskUserQuestion') return this.askQuestions(tabId, input, id, signal);
    if (tool === 'ExitPlanMode') return this.askPlan(tabId, input, id, signal);
    if (tool === 'EnterPlanMode') {
      this.setPlanning(tabId, true);
      return allow();
    }
    const ctx = this.contextOf(tabId);
    const verdict = classify(tool, input, ctx);
    if (this.planning.has(tabId) && verdict.tier !== 'blocked' && !this.planSafe(tool, input, verdict)) {
      return deny(
        `Plan mode: only reading and planning until the user approves the plan (write it in ${PLANS_DIR} and present it with ExitPlanMode).`,
      );
    }
    const at = Date.now();
    // Red asks when "Ask before risky actions" is on; yellow too when "confirm changes" is on (both in Settings › Safety).
    // Sending to someone the user didn't ask to send to asks even with cards off (persona rule 12).
    const settings = loadSettings();
    const sending = verdict.tier !== 'blocked' && isSending(tool, input) && !askedToSend(tool, input, this.turnText.get(tabId) ?? '');
    const asks =
      ((verdict.tier === 'red' && settings.askRisky) || (verdict.tier === 'yellow' && settings.confirmYellow) || sending) &&
      !this.trustedTurns.has(tabId);
    const status = verdict.tier === 'blocked' ? 'blocked' : asks ? 'pending' : 'running';
    this.actions.add({ id, tabId, at, tool, tier: verdict.tier, summary: verdict.summary, reason: verdict.reason, status, input });

    if (verdict.tier === 'blocked') {
      this.publish(id);
      // Harv's own data is off-limits, but the work itself isn't: it belongs in the workspace.
      if (/only changed by Harv itself/.test(verdict.reason))
        return deny(
          `${verdict.reason} Only ${HARV_HOME_HINT} outside the workspace is off-limits: do the same work in your workspace (${WORKSPACE}) or the temp folder instead. That's allowed, and not a way around this block; your workspace was never blocked.`,
        );
      return deny(`${verdict.reason} Tell the user it was blocked and why; don't try another way around it.`);
    }
    if (verdict.tier === 'green') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };

    if (!asks) {
      if (verdict.tier === 'red') {
        this.approved.add(id);
        this.actions.update(id, {
          result: this.trustedTurns.has(tabId) ? 'Approved with the rest of this reply.' : 'Ran without asking (Settings › Safety).',
        });
      }
      this.backup(id, verdict.targets);
      this.publish(id);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    }

    // Red (or yellow with confirm on): safety check and preview, backup, then the user decides.
    const backup = this.backup(id, verdict.targets);
    const backedUp = backup?.entries.filter((e) => e.copy).map((e) => e.original) ?? [];
    const rules = SHELL_TOOLS.includes(tool) ? rulesFor(String(input.command ?? ''), ctx) : null;
    const notes: string[] = [];
    if (backup?.skipped.length) notes.push(`Too big to back up: ${backup.skipped.join(', ')}.`);
    if (backedUp.length === 0) notes.push('Nothing to back up was found, so Undo won’t be available for this one.');
    const approval: ApprovalRequest = {
      id,
      tabId,
      at,
      tool,
      summary: verdict.summary,
      reason: verdict.reason,
      ...(SHELL_TOOLS.includes(tool) ? { command: String(input.command ?? '') } : {}),
      preview: buildPreview(tool, input, verdict),
      backups: backedUp,
      ...(notes.length ? { backupNote: notes.join(' ') } : {}),
      ...(rules?.length ? { rules } : {}),
      ...(sending ? { sending: true } : {}),
    };
    this.publish(id);
    const decision = await this.ask(approval, signal);

    if (!decision.approve) {
      this.actions.update(id, {
        status: 'denied',
        result: decision.why === STOPPED ? 'Stopped by the user.' : (decision.why ?? 'Denied by the user.'),
      });
      this.publish(id);
      if (decision.why && decision.why !== STOPPED)
        return deny(`The user denied this action and said: "${decision.why}". Go by that; don’t retry it unchanged.`);
      return deny(decision.why ?? 'The user denied this action. Ask what they would like instead; don’t retry it unchanged.');
    }

    let runInput = input;
    if (decision.command !== undefined && decision.command !== input.command) {
      // The user edited the command: it gets checked again, and only blocked things are refused.
      const edited = classify(tool, { ...input, command: decision.command }, ctx);
      if (edited.tier === 'blocked') {
        this.actions.update(id, { status: 'blocked', result: edited.reason });
        this.publish(id);
        return deny(edited.reason);
      }
      runInput = { ...input, command: decision.command };
      this.actions.update(id, { input: runInput });
    }
    if (decision.always) {
      const allow = SHELL_TOOLS.includes(tool) ? rulesFor(String(runInput.command ?? ''), ctx) : null;
      if (allow?.length) this.hooks.allow?.(allow);
    }
    this.approved.add(id);
    this.actions.update(id, { status: 'running' });
    this.publish(id);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        ...(runInput !== input ? { updatedInput: runInput } : {}),
      },
    };
  }

  /** Claude's multiple-choice questions: a question card, and the answers go back in the tool's input. */
  private async askQuestions(tabId: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    const questions = questionsOf(input);
    if (!questions.length) return deny('AskUserQuestion needs at least one question with options.');
    const card: ApprovalRequest = {
      kind: 'question',
      id,
      tabId,
      at: Date.now(),
      tool: 'AskUserQuestion',
      summary: questions[0]!.question,
      reason: '',
      preview: '',
      backups: [],
      questions,
    };
    const decision = await this.ask(card, signal);
    if (decision.why === STOPPED) return deny(STOPPED);
    if (!decision.approve || !decision.answers) {
      return deny(
        decision.why
          ? `The user didn't pick an answer; they wrote: "${decision.why}". Go by that.`
          : "The user dismissed the questions without answering. Don't ask them again; go on with sensible defaults or ask in plain text.",
      );
    }
    return allow({ ...input, answers: decision.answers });
  }

  /** ExitPlanMode: the plan goes on a card; approving it ends plan mode, a note sends Claude back to revise it. */
  private async askPlan(tabId: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    const card: ApprovalRequest = {
      kind: 'plan',
      id,
      tabId,
      at: Date.now(),
      tool: 'ExitPlanMode',
      summary: 'Plan ready',
      reason: '',
      preview: '',
      backups: [],
      plan: planOf(input),
    };
    const decision = await this.ask(card, signal);
    if (decision.why === STOPPED) return deny(STOPPED);
    if (decision.approve) {
      this.setPlanning(tabId, false);
      return allow();
    }
    return deny(
      decision.why
        ? `The user wants changes to the plan: "${decision.why}". Stay in plan mode, revise the plan and present it again with ExitPlanMode.`
        : "The user didn't approve the plan. Stay in plan mode and ask what they'd like changed.",
    );
  }

  private ask(approval: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      const finish = (d: Decision) => {
        if (!this.pending.delete(approval.id)) return;
        signal.removeEventListener('abort', onAbort);
        this.hooks.broadcast({ type: 'approval.resolved', id: approval.id, tabId: approval.tabId, approved: d.approve });
        this.hooks.onChange();
        resolve(d);
      };
      const onAbort = () => finish({ approve: false, why: STOPPED });
      this.pending.set(approval.id, { approval, resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      this.hooks.broadcast({ type: 'approval.request', approval });
      this.hooks.onChange();
    });
  }

  /** The user's answer from a card (a question card's `answers`; `why`: what they wrote instead). */
  answer(
    id: string,
    approve: boolean,
    command?: string,
    always = false,
    all = false,
    extra: { answers?: Record<string, string>; why?: string } = {},
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const why = extra.why?.trim();
    pending.resolve({
      approve,
      ...(approve && command !== undefined ? { command } : {}),
      ...(approve && always ? { always } : {}),
      ...(approve && extra.answers ? { answers: extra.answers } : {}),
      ...(why ? { why } : {}),
    });
    if (!approve || !all || pending.approval.kind === 'question' || pending.approval.kind === 'plan') return;
    // "Approve all for this reply": this card, the others waiting in the tab, and whatever else this turn asks.
    const { tabId } = pending.approval;
    this.trustedTurns.add(tabId);
    for (const p of [...this.pending.values()]) if (p.approval.tabId === tabId) p.resolve({ approve: true });
  }

  /** The turn ended (or was stopped): "Approve all for this reply" is over. */
  turnEnded(tabId: string): void {
    this.trustedTurns.delete(tabId);
    this.turnText.delete(tabId);
  }

  /** Stop: every approval waiting in this tab is denied. */
  cancel(tabId: string): void {
    this.trustedTurns.delete(tabId);
    for (const p of [...this.pending.values()]) {
      if (p.approval.tabId === tabId) p.resolve({ approve: false, why: STOPPED });
    }
  }

  /** Backstop for Claude Code's own permission prompts: never let a red call through without an approval. */
  async canUseTool(tool: string, input: Record<string, unknown>, id: string, tabId?: string): Promise<PermissionResult> {
    const verdict = classify(tool, input, tabId ? this.contextOf(tabId) : { projects: this.hooks.projects?.() });
    if (verdict.tier === 'blocked') return { behavior: 'deny', message: verdict.reason };
    if (verdict.tier === 'red' && !this.approved.has(id)) return { behavior: 'deny', message: 'This needs the user’s approval first.' };
    return { behavior: 'allow', updatedInput: input };
  }

  /** PostToolUse: verify and log the outcome. */
  done(tool: string, input: Record<string, unknown>, id: string, response: unknown): void {
    let result = 'Done.';
    if (FILE_WRITE_TOOLS.includes(tool)) {
      result = existsSync(String(input.file_path)) ? 'Verified: the file is in place.' : 'Warning: the file isn’t there afterwards.';
    } else if (SHELL_TOOLS.includes(tool) && response && typeof response === 'object') {
      const r = response as { stdout?: string; stderr?: string; interrupted?: boolean };
      if (r.interrupted) result = 'Interrupted.';
      else if (r.stderr?.trim()) result = `Finished with messages: ${r.stderr.trim().slice(0, MAX_RESULT)}`;
      else result = 'Finished without errors.';
    }
    this.finish(id, 'done', result);
  }

  failed(id: string, error: string, interrupted?: boolean): void {
    this.finish(id, 'failed', interrupted ? 'Stopped by the user.' : error.slice(0, MAX_RESULT));
  }

  private finish(id: string, status: 'done' | 'failed', result: string) {
    this.approved.delete(id);
    this.backups.delete(id);
    if (!this.actions.get(id)) return;
    this.actions.update(id, { status, result });
    this.publish(id);
  }

  /** Undo: put the backed-up files back (what's there now is kept aside too). */
  undo(id: string): void {
    const action = this.actions.get(id);
    const dir = this.actions.backupDir(id);
    const backup = dir ? readBackup(dir) : null;
    if (!action || !action.canUndo || !backup) {
      if (action) this.hooks.notice(action.tabId, `Can’t undo “${action.summary}”: there’s no backup for it.`);
      return;
    }
    try {
      const { restored, removed } = restoreBackup(backup);
      const parts = [
        restored.length ? `Restored ${restored.join(', ')}.` : '',
        removed.length ? `Removed ${removed.join(', ')} (kept in ${backup.dir} in case you want it back).` : '',
      ].filter(Boolean);
      this.actions.update(id, { status: 'undone', result: parts.join(' ') });
      this.hooks.notice(action.tabId, `Undone: ${action.summary}. ${parts.join(' ')}`);
    } catch (err) {
      this.hooks.notice(action.tabId, `Undo failed: ${(err as Error).message}. The backup is still in ${backup.dir}.`);
    }
    this.publish(id);
  }
}
