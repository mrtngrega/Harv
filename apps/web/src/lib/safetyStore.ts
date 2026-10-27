import type { ActionEntry, ApprovalRequest } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';

export interface SafetyState {
  /** Red actions waiting for the user, oldest first. */
  approvals: ApprovalRequest[];
  /** The action log by id (tool lines in the chat look up their action here). */
  actions: Record<string, ActionEntry>;
}

const store = createStore<SafetyState>({ approvals: [], actions: {} });
export const useSafety = store.use;

onServerMessage((msg) => {
  switch (msg.type) {
    case 'hello':
      store.set({ approvals: msg.approvals, actions: Object.fromEntries(msg.actions.map((a) => [a.id, a])) });
      break;
    case 'approval.request':
      store.set((s) => ({ ...s, approvals: [...s.approvals.filter((a) => a.id !== msg.approval.id), msg.approval] }));
      break;
    case 'approval.resolved':
      store.set((s) => ({ ...s, approvals: s.approvals.filter((a) => a.id !== msg.id) }));
      break;
    case 'action':
      store.set((s) => ({ ...s, actions: { ...s.actions, [msg.action.id]: msg.action } }));
      break;
  }
});

export const safety = {
  /**
   * `always`: don't ask again for this kind of command; `all`: approve the rest of this reply too;
   * `answers`: a question card's answers; `why`: what the user wrote instead (a plan's changes).
   */
  answer(
    id: string,
    approve: boolean,
    command?: string,
    { always = false, all = false, answers, why }: { always?: boolean; all?: boolean; answers?: Record<string, string>; why?: string } = {},
  ) {
    sendMessage({
      type: 'approval.answer',
      id,
      approve,
      ...(command !== undefined ? { command } : {}),
      ...(always ? { always } : {}),
      ...(all ? { all } : {}),
      ...(answers ? { answers } : {}),
      ...(why?.trim() ? { why: why.trim() } : {}),
    });
  },
  undo(id: string) {
    sendMessage({ type: 'action.undo', id });
  },
};

/** Newest first, for the action log card. */
export function recentActions(state: SafetyState, limit = 15): ActionEntry[] {
  return Object.values(state.actions)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
