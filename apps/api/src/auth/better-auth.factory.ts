import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import type { BetterAuthModules } from './better-auth-esm';
import { loadBetterAuthModules } from './better-auth-esm';
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
  let host: string;
  try {
    host = new URL(request.url).host;
  } catch {
    return [];
  }
  if (host === '') {
    return [];
  }
  return [`http://${host}`, `https://${host}`];
}

function trustedOriginsFor(config: WorkspaceConfig): (request: Request | undefined) => string[] {
  return (request) => {
    if (config.publicUrl !== null) {
      return config.trustedOrigins;
    }
    return [...config.trustedOrigins, ...sameHostOrigins(request)];
  };
}

function databaseFor(handle: RawDatabaseHandle, modules: BetterAuthModules): unknown {
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
 * `undefined` leaves better-auth's own default in place, which marks cookies
 * Secure in production. We only override it when the deployment tells us the
 * scheme: an explicit public URL, or a direct install with no declared proxy,
 * which is the plain-HTTP case that Secure cookies would lock out.
 */
export function secureCookiesFor(config: WorkspaceConfig): boolean | undefined {
  if (config.publicUrl !== null) {
    return config.publicUrl.startsWith('https://');
  }
  if (config.trustProxy === true) {
    return undefined;
  }
  return false;
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
    database: databaseFor(options.handle, modules) as never,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: {
      expiresIn: SESSION_SECONDS,
      cookieCache: { enabled: true, maxAge: SESSION_CACHE_SECONDS },
    },
    rateLimit: { enabled: true },
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
  const modules = await loadBetterAuthModules();
  const { runMigrations } = await modules.getMigrations(auth.options);
  await runMigrations();
}

export async function countUsers(auth: BetterAuthInstance): Promise<number> {
  const context = await auth.$context;
  return context.adapter.count({ model: 'user' });
}
