import { describe, expect, it, vi } from 'vitest';
import type { WatchdogAlert } from '@harv/shared';

vi.mock('../lib/socket.ts', () => ({ onServerMessage: () => () => {}, onConnectionChange: () => () => {}, sendMessage: () => true }));
const { addToast } = await import('./Toasts.tsx');

const alert = (id: string, severity: 'warning' | 'critical') =>
  ({ id, severity, title: id, detail: '', at: 0 }) as unknown as WatchdogAlert;
const watchdog = (id: string, severity: 'warning' | 'critical' = 'warning') =>
  ({ key: `watchdog:${id}`, kind: 'watchdog', alert: alert(id, severity) }) as const;

describe('toasts', () => {
  it('puts the newest on top and replaces the same toast instead of repeating it', () => {
    let list = addToast([], watchdog('a'));
    list = addToast(list, watchdog('b'));
    list = addToast(list, watchdog('a'));
    expect(list.map((t) => t.key)).toEqual(['watchdog:a', 'watchdog:b']);
  });

  it('drops the oldest info first and keeps warnings', () => {
    let list = addToast([], watchdog('critical', 'critical'));
    for (const id of ['1', '2', '3', '4']) list = addToast(list, watchdog(id));
    expect(list.map((t) => t.key)).toEqual(['watchdog:4', 'watchdog:3', 'watchdog:2', 'watchdog:critical']);
  });
});
