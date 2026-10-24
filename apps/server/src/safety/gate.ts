import { existsSync, statSync } from 'node:fs';
import type { HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalRequest, SafetyServerMessage } from '@harv/shared';
import type { ActionStore } from '../store/actions.ts';
import { createBackup, readBackup, restoreBackup, type Backup } from './backup.ts';
import { classify, FILE_WRITE_TOOLS, rulesFor, SHELL_TOOLS, type Verdict } from './classify.ts';
import { loadSettings } from './paths.ts';

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
  /** "Don't ask again": save these rules (Settings › Safety). */
  allow?: (rules: string[]) => void;
}

type Decision = { approve: boolean; command?: string; why?: string; always?: boolean };

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
    lines.push(`${tool === 'PowerShell' ? 'PS>' : '$'} ${String(input.command ?? '')}`);
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

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

export class SafetyGate {
  private pending = new Map<string, { approval: ApprovalRequest; resolve: (d: Decision) => void }>();
  /** Red calls the user approved; canUseTool double-checks against this. */
  private approved = new Set<string>();
  private backups = new Map<string, Backup>();

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

  /** The PreToolUse hook. Red calls wait here until the user answers the approval card. */
  async preToolUse(tabId: string, tool: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<HookJSONOutput> {
    const ctx = { project: this.hooks.projectOf?.(tabId), projects: this.hooks.projects?.() };
    const verdict = classify(tool, input, ctx);
    const at = Date.now();
    // Red always asks; yellow asks too when the user turned on "confirm changes" in Settings.
    const asks = verdict.tier === 'red' || (verdict.tier === 'yellow' && loadSettings().confirmYellow);
    const status = verdict.tier === 'blocked' ? 'blocked' : asks ? 'pending' : 'running';
    this.actions.add({ id, tabId, at, tool, tier: verdict.tier, summary: verdict.summary, reason: verdict.reason, status, input });

    if (verdict.tier === 'blocked') {
      this.publish(id);
      return deny(`${verdict.reason} Tell the user it was blocked and why; don't try another way around it.`);
    }
    if (verdict.tier === 'green') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };

    if (!asks) {
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
    };
    this.publish(id);
    const decision = await this.ask(approval, signal);

    if (!decision.approve) {
      this.actions.update(id, { status: 'denied', result: decision.why ?? 'Denied by the user.' });
      this.publish(id);
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

  private ask(approval: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    return new Promise((resolve) => {
      const finish = (d: Decision) => {
        if (!this.pending.delete(approval.id)) return;
        signal.removeEventListener('abort', onAbort);
        this.hooks.broadcast({ type: 'approval.resolved', id: approval.id, tabId: approval.tabId, approved: d.approve });
        this.hooks.onChange();
        resolve(d);
      };
      const onAbort = () => finish({ approve: false, why: 'Stopped by the user.' });
      this.pending.set(approval.id, { approval, resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      this.hooks.broadcast({ type: 'approval.request', approval });
      this.hooks.onChange();
    });
  }

  /** The user's answer from the approval card. */
  answer(id: string, approve: boolean, command?: string, always = false): void {
    this.pending
      .get(id)
      ?.resolve({ approve, ...(approve && command !== undefined ? { command } : {}), ...(approve && always ? { always } : {}) });
  }

  /** Stop: every approval waiting in this tab is denied. */
  cancel(tabId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.approval.tabId === tabId) p.resolve({ approve: false, why: 'Stopped by the user.' });
    }
  }

  /** Backstop for Claude Code's own permission prompts: never let a red call through without an approval. */
  async canUseTool(tool: string, input: Record<string, unknown>, id: string, tabId?: string): Promise<PermissionResult> {
    const verdict = classify(tool, input, {
      project: tabId ? this.hooks.projectOf?.(tabId) : undefined,
      projects: this.hooks.projects?.(),
    });
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
