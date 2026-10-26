import { invoke, isTauri } from '@tauri-apps/api/core';
import { warningText } from '../components/Toasts.tsx';
import { getChatState } from './chatStore.ts';
import { onServerMessage } from './socket.ts';
import { getConnection, subscribeConnection } from './useHarvSocket.ts';

/**
 * The bridge to Harv's desktop app (apps/desktop, docs/PLAN.md §6p). In a browser it does nothing;
 * in the app the dashboard draws its own title bar, feeds the tray icon Harv's status, and turns
 * what needs the user into system notifications when the window isn't in front.
 */
export const inApp = isTauri();

export interface AppSettings {
  hotkey: string;
  autostart: boolean;
  /** False on Wayland: the hotkey is then a KDE shortcut that runs `harv`. */
  hotkeyWorks: boolean;
  version: string;
}

export interface UpdateInfo {
  behind: number;
  dirty: boolean;
  error: string | null;
}

export const desktop = {
  window(action: 'drag' | 'minimize' | 'maximize' | 'close') {
    void invoke('window_action', { action });
  },
  settings: () => invoke<AppSettings>('app_settings'),
  setSettings: (patch: { hotkey?: string; autostart?: boolean }) => invoke<AppSettings>('set_app_settings', patch),
  checkUpdates: () => invoke<UpdateInfo>('check_updates'),
  applyUpdate: () => invoke<UpdateInfo>('apply_update'),
  /** The system's own picker (one picker can't take files and folders at once). */
  pickPaths: (folders: boolean) => invoke<{ path: string; folder: boolean }[]>('pick_paths', { folders }),
};

/** "KeyH" → "H", "Digit1" → "1"; other codes (F5, Space, ArrowUp) stay as they are. */
const keyName = (code: string) => code.replace(/^Key|^Digit/, '');

/** A key combination from a keydown, in the form the app's hotkey takes ("Ctrl+Alt+H"); null until a real key joins the modifiers. */
export function comboOf(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (/^(Control|Alt|Shift|Meta|OS)/.test(e.code)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  // A hotkey without Ctrl, Alt or Super would fire while typing.
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return [...mods, keyName(e.code)].join('+');
}

const notify = (title: string, body: string) => void invoke('notify', { title, body }).catch(() => {});

if (inApp) {
  // The tray icon shows Harv's status; "offline" while the dashboard can't reach the server.
  let shown = '';
  const showStatus = () => {
    const { connected, status } = getConnection();
    const next = connected ? status : 'offline';
    if (next === shown) return;
    shown = next;
    void invoke('set_status', { status: next }).catch(() => {});
  };
  subscribeConnection(showStatus);
  showStatus();

  const tabTitle = (tabId: string) => getChatState().tabs.find((t) => t.id === tabId)?.title ?? 'Harv';
  onServerMessage((msg) => {
    switch (msg.type) {
      case 'approval.request':
        notify('Harv needs your OK', msg.approval.summary);
        break;
      case 'chat.done':
        if (msg.error) notify(`Harv hit an error · ${tabTitle(msg.tabId)}`, msg.error);
        else if (msg.ok && !msg.stopped) notify('Harv replied', tabTitle(msg.tabId));
        break;
      case 'usage.warning':
        notify('Harv · plan usage', warningText(msg.warning));
        break;
      case 'watchdog.alert':
        notify(msg.alert.title, msg.alert.detail);
        break;
      case 'project.notice':
        notify('Harv', msg.message);
        break;
    }
  });
}
