import { useEffect, useState } from 'react';
import type { HarvStatus, ServerMessage } from '@harv/shared';

export interface HarvConnection {
  connected: boolean;
  status: HarvStatus;
  version: string | null;
}

/** Keeps one WebSocket to the Harv server open, reconnecting with backoff. */
export function useHarvSocket(): HarvConnection {
  const [conn, setConn] = useState<HarvConnection>({ connected: false, status: 'idle', version: null });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let disposed = false;

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws`);

      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.type === 'hello') {
          delay = 500;
          setConn({ connected: true, status: msg.status, version: msg.version });
        } else if (msg.type === 'harv.status') {
          setConn((c) => ({ ...c, status: msg.status }));
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setConn((c) => ({ ...c, connected: false }));
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return conn;
}
