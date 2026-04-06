import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@betterdb/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@betterdb/shared/license': path.resolve(__dirname, '../../packages/shared/src/license/index.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
