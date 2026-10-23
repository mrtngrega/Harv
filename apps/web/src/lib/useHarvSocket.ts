import type { Catalog, HarvStatus, MetricsSnapshot, PlanUsage } from '@harv/shared';
import { createStore } from './createStore.ts';
import { onConnectionChange, onServerMessage } from './socket.ts';

export interface HarvConnection {
  connected: boolean;
  status: HarvStatus;
  version: string | null;
}

// Separate stores so the 1 s metrics ticks only re-render what reads metrics.
const connection = createStore<HarvConnection>({ connected: false, status: 'idle', version: null });
const metrics = createStore<MetricsSnapshot | null>(null);
const catalog = createStore<Catalog | null>(null);
const usage = createStore<PlanUsage | null>(null);

onConnectionChange((connected) => connection.set((c) => ({ ...c, connected })));

onServerMessage((msg) => {
  switch (msg.type) {
    case 'hello':
      connection.set({ connected: true, status: msg.status, version: msg.version });
      if (msg.metrics) metrics.set(msg.metrics);
      if (msg.catalog) catalog.set(msg.catalog);
      usage.set(msg.usage);
      break;
    case 'harv.status':
      connection.set((c) => ({ ...c, status: msg.status }));
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
  }
});

export const useConnection = connection.use;
export const useMetrics = metrics.use;
export const useCatalog = catalog.use;
export const useUsage = usage.use;
