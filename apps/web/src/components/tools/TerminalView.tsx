import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalId } from '@harv/shared';
import { terminalStart } from '../../lib/chatStore.ts';
import { onServerMessage, sendMessage } from '../../lib/socket.ts';
import { useSettings } from '../../lib/useHarvSocket.ts';

/** A chat's PowerShell (its view menu): xterm.js on top of the server's pseudo-terminal. */
export function TerminalView({ chatId }: { chatId: string }) {
  const id = terminalId(chatId);
  const host = useRef<HTMLDivElement>(null);
  const { accent } = useSettings();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      // The glass panel's dark blue, so the terminal sits in the dashboard instead of a black box.
      theme: {
        background: '#121b25',
        foreground: '#e8edf2',
        cursor: accent,
        selectionBackground: 'rgba(168,200,232,0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const resize = () => {
      try {
        fit.fit();
        sendMessage({ type: 'term.resize', id, cols: term.cols, rows: term.rows });
      } catch {
        // Hidden or zero-sized.
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    const typed = term.onData((data) => sendMessage({ type: 'term.input', id, data }));
    const off = onServerMessage((msg) => {
      if (msg.type === 'term.data' && msg.id === id) {
        if (msg.reset) term.reset();
        const restored = msg.restored ?? [];
        if (restored.length) {
          // From before a restart: grey, then a screen's worth of lines so it sits in the scrollback
          // (PowerShell clears the screen when it starts).
          term.write(`${restored.map((l) => `\x1b[90m${l}\x1b[0m`).join('\r\n')}${'\r\n'.repeat(term.rows)}`);
        }
        term.write(msg.data, () => {
          // Show the end of the old output and the new prompt together.
          if (restored.length) term.scrollLines(-Math.floor(term.rows / 2));
        });
      } else if (msg.type === 'term.exit' && msg.id === id) {
        term.write(
          `\r\n\x1b[90m[PowerShell exited with code ${msg.code}. Close it in the view menu (top right) and open it again.]\x1b[0m\r\n`,
        );
      } else if (msg.type === 'hello') {
        // Reconnected (e.g. the server restarted): ask for the output again.
        sendMessage({ type: 'term.attach', id });
      }
    });
    // Starts the shell (in the folder the explorer asked for, if any), or shows whatever ran while it wasn't showing.
    const cwd = terminalStart.get(chatId);
    terminalStart.delete(chatId);
    sendMessage({ type: 'term.attach', id, ...(cwd ? { cwd } : {}) });
    resize();
    term.focus();

    return () => {
      off();
      typed.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [id, chatId, accent]);

  return (
    <div
      ref={host}
      className="harv-term min-h-0 flex-1 bg-[#121b25] px-3 py-2"
      onClick={(e) => e.currentTarget.querySelector('textarea')?.focus()}
    />
  );
}
