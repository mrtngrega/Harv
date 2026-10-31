import type { LightChange, LightsStatus } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onConnectionChange, onServerMessage, sendMessage } from './socket.ts';

// The user's light strip (docs/PLAN.md §6z): the Lights card in the stats panel and Settings › Devices.

const store = createStore<LightsStatus | null>(null);
export const useLights = store.use;

onServerMessage((msg) => {
  if (msg.type === 'lights') store.set(() => msg.status);
});
// Asked for on every (re)connection; the server then reads the lights and sends them again.
onConnectionChange((connected) => {
  if (connected) sendMessage({ type: 'lights.get' });
});

export const lights = {
  set: (id: string, change: LightChange) => sendMessage({ type: 'lights.set', id, change }),
  scan: () => sendMessage({ type: 'lights.scan' }),
  choose: (id: string, chosen: boolean) => sendMessage({ type: 'lights.choose', id, chosen }),
};

/** Quick picks for the card: whites first, then colours. */
export const QUICK_COLORS: { label: string; change: LightChange }[] = [
  { label: 'Warm', change: { temp: 2700 } },
  { label: 'White', change: { temp: 4000 } },
  { label: 'Cool', change: { temp: 6500 } },
  { label: 'Red', change: { hue: 0, saturation: 100 } },
  { label: 'Orange', change: { hue: 30, saturation: 100 } },
  { label: 'Teal', change: { hue: 175, saturation: 100 } },
  { label: 'Blue', change: { hue: 235, saturation: 100 } },
  { label: 'Purple', change: { hue: 280, saturation: 100 } },
  { label: 'Pink', change: { hue: 330, saturation: 60 } },
];
