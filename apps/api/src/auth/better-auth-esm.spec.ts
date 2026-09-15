import { loadBetterAuthDate, loadBetterAuthModules } from './better-auth-esm';

describe('loadBetterAuthModules', () => {
  it('loads the ESM-only better-auth and kysely entry points', async () => {
    const modules = await loadBetterAuthModules();
    expect(typeof modules.betterAuth).toBe('function');
    expect(typeof modules.memoryAdapter).toBe('function');
    expect(typeof modules.getMigrations).toBe('function');
    expect(typeof modules.createAuthMiddleware).toBe('function');
    expect(typeof modules.createAuthEndpoint).toBe('function');
    expect(typeof modules.APIError).toBe('function');
    expect(typeof modules.setSessionCookie).toBe('function');
    expect(typeof modules.SqliteDialect).toBe('function');
  });

  it('returns the same promise on repeated calls', () => {
    expect(loadBetterAuthModules()).toBe(loadBetterAuthModules());
  });
});

describe('loadBetterAuthDate', () => {
  it('constructs real Date instances', async () => {
    const BetterAuthDate = await loadBetterAuthDate();
    const instance = new BetterAuthDate(1700000000000);
    expect(instance.getTime()).toBe(1700000000000);
  });

  it('returns the same promise on repeated calls', () => {
    expect(loadBetterAuthDate()).toBe(loadBetterAuthDate());
  });
});
