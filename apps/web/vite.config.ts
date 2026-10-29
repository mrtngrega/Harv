import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { SERVER_PORT } from '@harv/shared';

const server = `http://127.0.0.1:${SERVER_PORT}`;
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The phone opens the dashboard through `tailscale serve` (docs/PLAN.md §6q): https://<device>.<tailnet>.ts.net.
    // The server checks that name exactly; anything else is refused there.
    allowedHosts: ['.ts.net'],
    // Over the tailnet, only the dashboard's own code may be served, never the rest of the repo
    // (harv_report.md, .env…): the dashboard, the shared package and the installed packages.
    fs: { allow: [at('.'), at('../../packages/shared'), at('../../node_modules')] },
    // changeOrigin stays false: the server must see the real Host (the phone's ts.net name gets the phone's
    // checks). Vite's short `'/api': server` form sets it true, which made phone requests look local.
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ws': { target: server, ws: true, changeOrigin: false },
    },
  },
});
