/** The safety gate's levels (see CLAUDE.md "Harv's safety model"). */
export type Tier = 'green' | 'yellow' | 'red' | 'blocked';

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'blocked' | 'undone';

/** One tool call in the action log. Its id is the Claude tool_use id. */
export interface ActionEntry {
  id: string;
  tabId: string;
  at: number;
  tool: string;
  tier: Tier;
  /** What it does, in plain words. */
  summary: string;
  /** Why it got its tier. */
  reason: string;
  status: ActionStatus;
  /** Paths backed up before it ran. */
  backups: string[];
  canUndo: boolean;
  /** Short outcome: an error, or what verification found. */
  result?: string;
}

/** One backup as Settings › Safety › Backups lists it (`GET /api/backups`). */
export interface BackupInfo {
  /** The folder name inside ~/.harv/backups (what `POST /api/backups/keep` takes). */
  name: string;
  at: number;
  bytes: number;
  /** What was backed up. */
  originals: string[];
  /** Kept forever: the cleanup never deletes it. */
  kept: boolean;
}

/** One of Claude's multiple-choice questions (Claude Code's AskUserQuestion). */
export interface QuestionItem {
  question: string;
  /** A short chip label. */
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

/**
 * Something waiting for the user's decision: a red action (`action`, the default), Claude's
 * questions (`question`: the answers go back to Claude) or a plan to approve (`plan`).
 */
export interface ApprovalRequest {
  kind?: 'action' | 'question' | 'plan';
  id: string;
  tabId: string;
  at: number;
  tool: string;
  summary: string;
  reason: string;
  /** The exact command, which the user may edit before approving. */
  command?: string;
  /** Exactly what will be affected. */
  preview: string;
  /** Paths that were backed up first. */
  backups: string[];
  /** Set when no automatic backup was possible. */
  backupNote?: string;
  /** What "Don't ask again" would allow (e.g. ["npm install"]); missing when it can't be offered. */
  rules?: string[];
  /** `question`: what Claude asks. */
  questions?: QuestionItem[];
  /** `plan`: the plan, as Markdown. */
  plan?: string;
  /** This action sends something to someone the user didn't ask to send to (asked even with cards off). */
  sending?: boolean;
}

export type SafetyClientMessage =
  /**
   * `always`: approve, and don't ask again for this kind of command (Settings › Safety lists the rules).
   * `all`: approve this and everything else the current reply asks, until it ends.
   */
  /**
   * `answers`: a question card's answers by question text (several picks joined with ", ").
   * `why`: what the user said instead (a denied plan's feedback, or a reason).
   */
  | {
      type: 'approval.answer';
      id: string;
      approve: boolean;
      command?: string;
      always?: boolean;
      all?: boolean;
      answers?: Record<string, string>;
      why?: string;
    }
  | { type: 'action.undo'; id: string };

export type SafetyServerMessage =
  | { type: 'approval.request'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; tabId: string; approved: boolean }
  | { type: 'action'; action: ActionEntry };
