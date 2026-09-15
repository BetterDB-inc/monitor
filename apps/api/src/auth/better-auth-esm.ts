import { constants, runInThisContext } from 'vm';

type BetterAuthCore = typeof import('better-auth');
type BetterAuthMemory = typeof import('better-auth/adapters/memory');
type BetterAuthMigration = typeof import('better-auth/db/migration');
type BetterAuthApi = typeof import('better-auth/api');
type BetterAuthCookies = typeof import('better-auth/cookies');
type KyselyModule = typeof import('kysely');

export interface BetterAuthModules {
  betterAuth: BetterAuthCore['betterAuth'];
  memoryAdapter: BetterAuthMemory['memoryAdapter'];
  getMigrations: BetterAuthMigration['getMigrations'];
  createAuthMiddleware: BetterAuthApi['createAuthMiddleware'];
  createAuthEndpoint: BetterAuthApi['createAuthEndpoint'];
  APIError: BetterAuthApi['APIError'];
  setSessionCookie: BetterAuthCookies['setSessionCookie'];
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

async function importBetterAuthModules(): Promise<BetterAuthModules> {
  const esmImport = createEsmImport();
  const [core, memory, migration, api, cookies, kysely] = await Promise.all([
    esmImport('better-auth'),
    esmImport('better-auth/adapters/memory'),
    esmImport('better-auth/db/migration'),
    esmImport('better-auth/api'),
    esmImport('better-auth/cookies'),
    esmImport('kysely'),
  ]);
  const coreModule = core as BetterAuthCore;
  const memoryModule = memory as BetterAuthMemory;
  const migrationModule = migration as BetterAuthMigration;
  const apiModule = api as BetterAuthApi;
  const cookiesModule = cookies as BetterAuthCookies;
  const kyselyModule = kysely as KyselyModule;
  return {
    betterAuth: coreModule.betterAuth,
    memoryAdapter: memoryModule.memoryAdapter,
    getMigrations: migrationModule.getMigrations,
    createAuthMiddleware: apiModule.createAuthMiddleware,
    createAuthEndpoint: apiModule.createAuthEndpoint,
    APIError: apiModule.APIError,
    setSessionCookie: cookiesModule.setSessionCookie,
    SqliteDialect: kyselyModule.SqliteDialect,
  };
}

export function loadBetterAuthModules(): Promise<BetterAuthModules> {
  if (cached !== null) {
    return cached;
  }
  const pending = importBetterAuthModules().catch((error: unknown) => {
    if (cached === pending) {
      cached = null;
    }
    throw error;
  });
  cached = pending;
  return cached;
}

let cachedDateConstructor: Promise<DateConstructor> | null = null;

async function loadBetterAuthDateConstructor(): Promise<DateConstructor> {
  const esmImport = createEsmImport();
  const module = (await esmImport('data:text/javascript,export default Date;')) as {
    default: DateConstructor;
  };
  return module.default;
}

export function loadBetterAuthDate(): Promise<DateConstructor> {
  if (cachedDateConstructor !== null) {
    return cachedDateConstructor;
  }
  const pending = loadBetterAuthDateConstructor().catch((error: unknown) => {
    if (cachedDateConstructor === pending) {
      cachedDateConstructor = null;
    }
    throw error;
  });
  cachedDateConstructor = pending;
  return cachedDateConstructor;
}
