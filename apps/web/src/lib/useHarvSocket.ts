import {
  DEFAULT_SETTINGS,
  type Catalog,
  type HarvPlatform,
  type HarvSettings,
  type HarvStatus,
  type MetricsSnapshot,
  type PlanUsage,
  type Project,
  type SyncStatus,
} from '@harv/shared';
import { createStore } from './createStore.ts';
import { onConnectionChange, onServerMessage, sendMessage } from './socket.ts';

export interface HarvConnection {
  connected: boolean;
  status: HarvStatus;
  /** The running tool while working. */
  detail?: string;
  version: string | null;
  /** The OS the server runs on (Windows until the first hello says otherwise). */
  platform: HarvPlatform;
}

// Separate stores so the 1 s metrics ticks only re-render what reads metrics.
const connection = createStore<HarvConnection>({ connected: false, status: 'idle', version: null, platform: 'windows' });
const metrics = createStore<MetricsSnapshot | null>(null);
const catalog = createStore<Catalog | null>(null);
const usage = createStore<PlanUsage | null>(null);
// Missing keys fall back to the defaults (a server older than the dashboard after a hot reload).
const settings = createStore<HarvSettings>(DEFAULT_SETTINGS);
/** Folders Harv works on as projects, and the last error adding one. */
const projects = createStore<{ list: Project[]; error: string | null }>({ list: [], error: null });
/** Background photo version for cache-busting; null = none set, undefined = not known yet. */
const background = createStore<{ version: number | null | undefined }>({ version: undefined });
/** Sync with the user's other devices (null until the first hello). */
const sync = createStore<SyncStatus | null>(null);

onConnectionChange((connected) => connection.set((c) => ({ ...c, connected })));

onServerMessage((msg) => {
  switch (msg.type) {
    case 'hello':
      connection.set({ connected: true, status: msg.status, version: msg.version, platform: msg.platform ?? 'windows' });
      if (msg.metrics) metrics.set(msg.metrics);
      if (msg.catalog) catalog.set(msg.catalog);
      usage.set(msg.usage);
      settings.set({ ...DEFAULT_SETTINGS, ...msg.settings });
      background.set({ version: msg.background });
      projects.set({ list: msg.projects, error: null });
      sync.set(msg.sync ?? null);
      break;
    case 'sync.status':
      sync.set(msg.status);
      break;
    case 'projects':
      projects.set({ list: msg.projects, error: null });
      break;
    case 'project.error':
      projects.set((p) => ({ ...p, error: msg.message }));
      break;
    case 'harv.status':
      connection.set((c) => ({ ...c, status: msg.status, detail: msg.detail }));
      break;
    case 'metrics.tick':
      metrics.set(msg.metrics);
      break;
    case 'catalog':
      catalog.set(msg.catalog);
      break;
    case 'usage.update':
      usage.set(msg.usage);
      break;
    case 'settings':
      settings.set({ ...DEFAULT_SETTINGS, ...msg.settings });
      break;
    case 'background':
      background.set({ version: msg.version });
      break;
  }
});

export const useConnection = connection.use;
export const getConnection = connection.get;
export const subscribeConnection = connection.subscribe;
/** The OS the server runs on, for code outside React. */
export const getPlatform = () => connection.get().platform;
export const useMetrics = metrics.use;
export const useCatalog = catalog.use;
export const useUsage = usage.use;
export const useSettings = settings.use;
export const useBackground = background.use;
export const useProjects = projects.use;
export const getProjects = () => projects.get().list;
export const useSync = sync.use;
/** Settings › Sync › Sync now. */
export const syncNow = () => sendMessage({ type: 'sync.now' });

export const projectActions = {
  add(path: string, name?: string) {
    projects.set((p) => ({ ...p, error: null }));
    sendMessage({ type: 'project.add', path, ...(name ? { name } : {}) });
  },
  remove: (id: string) => sendMessage({ type: 'project.remove', id }),
};

/** Saves a settings change on the server, which echoes it to every window. */
export function updateSettings(patch: Partial<HarvSettings>): void {
  settings.set((s) => ({ ...s, ...patch }));
  sendMessage({ type: 'settings.update', patch });
}
