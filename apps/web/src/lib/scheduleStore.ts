import type { ScheduledTask } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onServerMessage, sendMessage } from './socket.ts';

/** Harv's scheduled tasks on this device (docs/PLAN.md §6s C4). */
const store = createStore<ScheduledTask[]>([]);
export const useSchedules = store.use;

onServerMessage((msg) => {
  if (msg.type === 'hello') store.set(msg.schedules ?? []);
  else if (msg.type === 'schedules') store.set(msg.tasks);
});

export function cancelSchedule(id: string): void {
  store.set((list) => list.filter((t) => t.id !== id));
  sendMessage({ type: 'schedule.cancel', id });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "every day at 08:00", "Mon, Fri at 18:30", "every 30 min", "once". */
export function whenText(task: ScheduledTask): string {
  const s = task.schedule;
  if (s.kind === 'once') return 'once';
  if (s.kind === 'every') return s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`;
  const days = s.days?.length && s.days.length < 7 ? s.days.map((d) => DAYS[d]).join(', ') : 'every day';
  return `${days} at ${s.time}`;
}
