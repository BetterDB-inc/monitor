import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@betterdb/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@betterdb/shared/license': path.resolve(__dirname, '../../packages/shared/src/license/index.ts'),
    },
  },
});
