import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer for the ML Copilot Electron app.
// Dev: `vite` serves app/ on :5173. Prod: static build consumed from desktop/renderer-dist.
export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: '../desktop/renderer-dist',
    emptyOutDir: true,
  },
});
