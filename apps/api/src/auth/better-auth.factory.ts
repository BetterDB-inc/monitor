import type { BetterAuthOptions } from 'better-auth';
import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import type { BetterAuthModules } from './better-auth-esm';
import { loadBetterAuthModules } from './better-auth-esm';
import { brokerSessionPlugin } from './broker/broker-session.plugin';
import { originsForHost } from './trusted-origins';
import type { WorkspaceConfig } from './workspace-config';

export const BETTER_AUTH = 'BETTER_AUTH';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_CACHE_SECONDS = 30;
const SIGN_UP_PATH = '/sign-up/email';
const REGISTRATION_CLOSED = 'Registration is closed. Ask a workspace admin for an invite.';

export const CLIENT_IP_HEADER = 'x-betterdb-client-ip';

export interface CreateBetterAuthOptions {
  handle: RawDatabaseHandle;
  secret: string;
  config: WorkspaceConfig;
}

function emptyMemoryDb(): Record<string, unknown[]> {
  return { user: [], session: [], account: [], verification: [] };
}

function sameHostOrigins(request: Request | undefined): string[] {
  if (request === undefined) {
    return [];
  }
  try {
    return originsForHost(new URL(request.url).host);
  } catch {
    return [];
  }
}

function trustedOriginsFor(config: WorkspaceConfig): (request: Request | undefined) => string[] {
  return (request) => {
    if (config.publicUrl !== null) {
      return config.trustedOrigins;
    }
    return [...config.trustedOrigins, ...sameHostOrigins(request)];
  };
}

function databaseFor(
  handle: RawDatabaseHandle,
  modules: BetterAuthModules,
): BetterAuthOptions['database'] {
  if (handle.kind === 'sqlite') {
    return handle.db;
  }
  if (handle.kind === 'libsql') {
    return { dialect: new modules.SqliteDialect({ database: handle.db }), type: 'sqlite' };
  }
  if (handle.kind === 'postgres') {
    return handle.pool;
  }
  return modules.memoryAdapter(emptyMemoryDb());
}

/**
 * AUTH_PUBLIC_URL is the only configuration that states the scheme the browser
 * actually uses. TRUST_PROXY says forwarded headers are trusted, which is not
 * the same claim: a plain-HTTP reverse proxy sets it too. Guessing HTTPS from
 * it would mark cookies Secure on such an install and drop every session, so
 * an unset public URL keeps cookies unmarked and warns at boot instead.
 */
export function secureCookiesFor(config: WorkspaceConfig): boolean {
  return config.publicUrl?.startsWith('https://') === true;
}

export async function createBetterAuth(options: CreateBetterAuthOptions) {
  const modules = await loadBetterAuthModules();
  const { config } = options;
  let bootstrapPending = false;
  return modules.betterAuth({
    secret: options.secret,
    baseURL: config.publicUrl ?? undefined,
    basePath: config.basePath,
    trustedOrigins: trustedOriginsFor(config),
    database: databaseFor(options.handle, modules),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: {
      expiresIn: SESSION_SECONDS,
      cookieCache: { enabled: true, maxAge: SESSION_CACHE_SECONDS },
    },
    rateLimit: { enabled: true },
    plugins: [brokerSessionPlugin(modules)],
    advanced: {
      disableOriginCheck: false,
      trustedProxyHeaders: config.trustProxy,
      useSecureCookies: secureCookiesFor(config),
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'member', input: false },
        isOwner: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    hooks: {
      before: modules.createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_UP_PATH) {
          return;
        }
        const existing = await ctx.context.adapter.count({ model: 'user' });
        if (existing > 0) {
          throw new modules.APIError('FORBIDDEN', { message: REGISTRATION_CLOSED });
        }
        bootstrapPending = true;
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx === undefined || ctx === null) {
              return { data: user };
            }
            if (ctx.path !== SIGN_UP_PATH) {
              return { data: user };
            }
            if (bootstrapPending === false) {
              return { data: user };
            }
            bootstrapPending = false;
            return { data: { ...user, role: 'admin', isOwner: true } };
          },
        },
      },
    },
  });
}

export type BetterAuthInstance = Awaited<ReturnType<typeof createBetterAuth>>;

export async function runBetterAuthMigrations(
  auth: BetterAuthInstance,
  handle: RawDatabaseHandle,
): Promise<void> {
  if (handle.kind === 'memory') {
    return;
  }
  await relaxLegacyAccountIssuer(handle);
  const modules = await loadBetterAuthModules();
  const { runMigrations } = await modules.getMigrations(auth.options);
  await runMigrations();
}

const LEGACY_ISSUER_INDEX = 'account_issuer_accountId_uidx';

/**
 * Better Auth 1.7.0-1.7.2 created a required `account.issuer` column plus a
 * unique (issuer, accountId) index. 1.7.3+ never writes it, so on databases
 * migrated by those versions every account insert (sign-up, invite, broker
 * link) fails until the constraint is relaxed. Follows the upstream 1.7
 * upgrade guide: Postgres keeps the column but drops NOT NULL; SQLite cannot
 * alter a column, so it is dropped.
 */
export async function relaxLegacyAccountIssuer(handle: RawDatabaseHandle): Promise<void> {
  if (handle.kind === 'memory') {
    return;
  }
  if (handle.kind === 'postgres') {
    const result = await handle.pool.query<{ attnotnull: boolean }>(
      `SELECT a.attnotnull FROM pg_attribute a
        WHERE a.attrelid = to_regclass('account') AND a.attname = 'issuer' AND NOT a.attisdropped`,
    );
    if (result.rows.length === 0) {
      return;
    }
    await handle.pool.query(`DROP INDEX IF EXISTS "${LEGACY_ISSUER_INDEX}"`);
    if (result.rows[0].attnotnull === true) {
      await handle.pool.query('ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL');
    }
    return;
  }
  const columns = handle.db.prepare("PRAGMA table_info('account')").all() as { name: string }[];
  if (columns.some((column) => column.name === 'issuer') === false) {
    return;
  }
  handle.db.exec(`DROP INDEX IF EXISTS "${LEGACY_ISSUER_INDEX}"`);
  handle.db.exec('ALTER TABLE "account" DROP COLUMN "issuer"');
}

export async function countUsers(auth: BetterAuthInstance): Promise<number> {
  const context = await auth.$context;
  return context.adapter.count({ model: 'user' });
}
