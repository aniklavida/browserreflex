import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is served by the same process, on the same origin, so the UI calls relative
// `/api/...` paths. In development the proxy below points at a locally running server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:4040' } },
});
