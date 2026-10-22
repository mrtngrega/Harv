import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { SERVER_PORT } from '@harv/shared';

const server = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
});
