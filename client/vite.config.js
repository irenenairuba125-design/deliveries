import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  envDir: '..', // share the repo-root .env with the server
  server: {
    port: 5173,
    host: true, // reachable from a phone on the same Wi-Fi (for real GPS testing)
    proxy: {
      '/api': target,
      '/socket.io': { target, ws: true },
    },
  },
});
