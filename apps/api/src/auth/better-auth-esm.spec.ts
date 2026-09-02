import { loadBetterAuthModules } from './better-auth-esm';

describe('loadBetterAuthModules', () => {
  it('loads the ESM-only better-auth and kysely entry points', async () => {
    const modules = await loadBetterAuthModules();
    expect(typeof modules.betterAuth).toBe('function');
    expect(typeof modules.memoryAdapter).toBe('function');
    expect(typeof modules.getMigrations).toBe('function');
    expect(typeof modules.createAuthMiddleware).toBe('function');
    expect(typeof modules.APIError).toBe('function');
    expect(typeof modules.SqliteDialect).toBe('function');
  });

  it('returns the same promise on repeated calls', () => {
    expect(loadBetterAuthModules()).toBe(loadBetterAuthModules());
  });
});
