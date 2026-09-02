import { constants, runInThisContext } from 'vm';

type BetterAuthCore = typeof import('better-auth');
type BetterAuthMemory = typeof import('better-auth/adapters/memory');
type BetterAuthMigration = typeof import('better-auth/db/migration');
type BetterAuthApi = typeof import('better-auth/api');
type KyselyModule = typeof import('kysely');

export interface BetterAuthModules {
  betterAuth: BetterAuthCore['betterAuth'];
  memoryAdapter: BetterAuthMemory['memoryAdapter'];
  getMigrations: BetterAuthMigration['getMigrations'];
  createAuthMiddleware: BetterAuthApi['createAuthMiddleware'];
  APIError: BetterAuthApi['APIError'];
  SqliteDialect: KyselyModule['SqliteDialect'];
}

type EsmImport = (specifier: string) => Promise<unknown>;

function createEsmImport(): EsmImport {
  if (process.env.JEST_WORKER_ID === undefined) {
    return new Function('specifier', 'return import(specifier)') as EsmImport;
  }
  return runInThisContext('(specifier) => import(specifier)', {
    filename: __filename,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as EsmImport;
}

let cached: Promise<BetterAuthModules> | null = null;

export function loadBetterAuthModules(): Promise<BetterAuthModules> {
  if (cached !== null) {
    return cached;
  }
  const esmImport = createEsmImport();
  cached = Promise.all([
    esmImport('better-auth'),
    esmImport('better-auth/adapters/memory'),
    esmImport('better-auth/db/migration'),
    esmImport('better-auth/api'),
    esmImport('kysely'),
  ]).then(([core, memory, migration, api, kysely]) => {
    const coreModule = core as BetterAuthCore;
    const memoryModule = memory as BetterAuthMemory;
    const migrationModule = migration as BetterAuthMigration;
    const apiModule = api as BetterAuthApi;
    const kyselyModule = kysely as KyselyModule;
    return {
      betterAuth: coreModule.betterAuth,
      memoryAdapter: memoryModule.memoryAdapter,
      getMigrations: migrationModule.getMigrations,
      createAuthMiddleware: apiModule.createAuthMiddleware,
      APIError: apiModule.APIError,
      SqliteDialect: kyselyModule.SqliteDialect,
    };
  });
  return cached;
}
