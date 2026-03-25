import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globalSetup: ['./src/entitlement/__tests__/integration/global-setup.ts'],
  },
  resolve: {
    alias: {
      '@betterdb/shared': resolve(__dirname, '../../packages/shared/src/index'),
    },
  },
});
