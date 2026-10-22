import { useSyncExternalStore } from 'react';
import type { HarvStatus, MetricsSnapshot, ServerMessage } from '@harv/shared';

export interface HarvConnection {
  connected: boolean;
  status: HarvStatus;
  version: string | null;
}

// One WebSocket for the whole app. Components subscribe to just the slice they
// need, so the 1 s metrics ticks don't re-render the chat.
let connection: HarvConnection = { connected: false, status: 'idle', version: null };
let metrics: MetricsSnapshot | null = null;
const connectionListeners = new Set<() => void>();
const metricsListeners = new Set<() => void>();
let started = false;

function setConnection(next: HarvConnection) {
  connection = next;
  connectionListeners.forEach((l) => l());
}

function setMetrics(next: MetricsSnapshot | null) {
  metrics = next;
  metricsListeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  let delay = 500;

  const connect = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);

    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      switch (msg.type) {
        case 'hello':
          delay = 500;
          setConnection({ connected: true, status: msg.status, version: msg.version });
          if (msg.metrics) setMetrics(msg.metrics);
          break;
        case 'harv.status':
          setConnection({ ...connection, status: msg.status });
          break;
        case 'metrics.tick':
          setMetrics(msg.metrics);
          break;
      }
    };

    socket.onclose = () => {
      setConnection({ ...connection, connected: false });
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };

  connect();
}

function subscribeTo(listeners: Set<() => void>) {
  return (listener: () => void) => {
    start();
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

const subscribeConnection = subscribeTo(connectionListeners);
const subscribeMetrics = subscribeTo(metricsListeners);

export function useConnection(): HarvConnection {
  return useSyncExternalStore(subscribeConnection, () => connection);
}

export function useMetrics(): MetricsSnapshot | null {
  return useSyncExternalStore(subscribeMetrics, () => metrics);
}
