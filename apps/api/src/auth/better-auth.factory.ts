import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import type { BetterAuthModules } from './better-auth-esm';
import { loadBetterAuthModules } from './better-auth-esm';
import type { WorkspaceConfig } from './workspace-config';

export const BETTER_AUTH = 'BETTER_AUTH';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
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

export async function createBetterAuth(options: CreateBetterAuthOptions) {
  const modules = await loadBetterAuthModules();
  const { config } = options;
  const secureCookies = config.publicUrl?.startsWith('https://') === true;
  let bootstrapPending = false;
  return modules.betterAuth({
    secret: options.secret,
    baseURL: config.publicUrl ?? undefined,
    basePath: config.basePath,
    trustedOrigins: config.trustedOrigins,
    database: databaseFor(options.handle, modules) as never,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: { expiresIn: SESSION_SECONDS },
    rateLimit: { enabled: true },
    advanced: {
      disableOriginCheck: false,
      useSecureCookies: secureCookies,
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
