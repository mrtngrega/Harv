import type { ClientMessage, ServerMessage } from '@harv/shared';

// The one WebSocket to the Harv server. Stores subscribe to the messages they care about.
type MessageListener = (msg: ServerMessage) => void;
type ConnectionListener = (connected: boolean) => void;

const messageListeners = new Set<MessageListener>();
const connectionListeners = new Set<ConnectionListener>();
let socket: WebSocket | null = null;
let started = false;

/** Returns a function that stops listening (components unsubscribe when they unmount). */
export function onServerMessage(listener: MessageListener): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export function onConnectionChange(listener: ConnectionListener): void {
  connectionListeners.add(listener);
}

/** Returns false when not connected, so callers can tell the user. */
export function sendMessage(msg: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** A locked phone (docs/PLAN.md §6q) stops reconnecting until Face ID unlocks it again. */
let paused = false;
let reconnect: (() => void) | null = null;

export function pauseSocket(): void {
  paused = true;
  socket?.close();
}

export function resumeSocket(): void {
  if (!paused) return;
  paused = false;
  reconnect?.();
}

/** Fires with the close code each time the connection drops (4401: the phone's unlock ended). */
const closeListeners = new Set<(code: number) => void>();
export function onSocketClosed(listener: (code: number) => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

export function startSocket(): void {
  if (started) return;
  started = true;
  let delay = 500;

  const connect = () => {
    if (paused) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.onopen = () => {
      delay = 500;
      connectionListeners.forEach((l) => l(true));
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      messageListeners.forEach((l) => l(msg));
    };
    socket.onclose = (event) => {
      connectionListeners.forEach((l) => l(false));
      closeListeners.forEach((l) => l(event.code));
      if (paused) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  reconnect = () => {
    delay = 500;
    connect();
  };
  connect();
}
