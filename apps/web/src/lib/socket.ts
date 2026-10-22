import type { ClientMessage, ServerMessage } from '@harv/shared';

// The one WebSocket to the Harv server. Stores subscribe to the messages they care about.
type MessageListener = (msg: ServerMessage) => void;
type ConnectionListener = (connected: boolean) => void;

const messageListeners = new Set<MessageListener>();
const connectionListeners = new Set<ConnectionListener>();
let socket: WebSocket | null = null;
let started = false;

export function onServerMessage(listener: MessageListener): void {
  messageListeners.add(listener);
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

export function startSocket(): void {
  if (started) return;
  started = true;
  let delay = 500;

  const connect = () => {
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
    socket.onclose = () => {
      connectionListeners.forEach((l) => l(false));
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();
}
