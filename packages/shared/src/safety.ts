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

/** A red action waiting for the user's decision. */
export interface ApprovalRequest {
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
}

export type SafetyClientMessage =
  /** `always`: approve, and don't ask again for this kind of command (Settings › Safety lists the rules). */
  { type: 'approval.answer'; id: string; approve: boolean; command?: string; always?: boolean } | { type: 'action.undo'; id: string };

export type SafetyServerMessage =
  | { type: 'approval.request'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; tabId: string; approved: boolean }
  | { type: 'action'; action: ActionEntry };
