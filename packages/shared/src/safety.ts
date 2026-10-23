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
}

export type SafetyClientMessage =
  { type: 'approval.answer'; id: string; approve: boolean; command?: string } | { type: 'action.undo'; id: string };

export type SafetyServerMessage =
  | { type: 'approval.request'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; tabId: string; approved: boolean }
  | { type: 'action'; action: ActionEntry };
