import type { PhoneAccess, PhoneInfo } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';

/** Paired phones and phone access on this device (Settings › Phone, docs/PLAN.md §6q). */
const store = createStore<{ phones: PhoneInfo[]; access: PhoneAccess | null }>({ phones: [], access: null });
export const usePhones = store.use;

onServerMessage((msg) => {
  if (msg.type === 'phone.list') store.set({ phones: msg.phones, access: msg.access });
  // The server sends the list only when asked or when it changes.
  else if (msg.type === 'hello') sendMessage({ type: 'phone.list' });
});

export const askPhones = () => sendMessage({ type: 'phone.list' });
export const revokePhone = (id: string) => sendMessage({ type: 'phone.revoke', id });
