import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Order matters: Vite tries aliases in key order and a string alias also matches `find + '/'`, so the
      // subpath entry must come before '@netforge/engine' or '/pure' would resolve to 'index.ts/pure'.
      '@netforge/engine/pure': fileURLToPath(new URL('../../packages/engine/src/pure.ts', import.meta.url)),
      '@netforge/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    fs: {
      // allow importing engine sources from the monorepo root
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
