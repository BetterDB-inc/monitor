import { DynamicModule, Logger, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'path';
import { ActivityModule } from '../activity/activity.module';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { hasRawDatabaseHandle } from '../storage/raw-database-handle';
import { StorageModule } from '../storage/storage.module';
import { InvitationService } from '../workspace/invitation.service';
import { InviteController } from '../workspace/invite.controller';
import { MemberService } from '../workspace/member.service';
import { WorkspaceController } from '../workspace/workspace.controller';
import { WORKSPACE_STATUS, WorkspaceStatusService } from '../workspace/workspace-status.service';
import { ActorResolver } from './actor-resolver';
import { resolveAuthSecret } from './auth-secret';
import { BetterAuthController } from './better-auth.controller';
import {
  BETTER_AUTH,
  BetterAuthInstance,
  createBetterAuth,
  runBetterAuthMigrations,
} from './better-auth.factory';
import { ActorGuard } from './guards/actor.guard';
import { MutationGuard } from './guards/mutation.guard';
import { RolesGuard } from './guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG, WorkspaceConfig } from './workspace-config';

const DEFAULT_DATA_DIR = join(process.cwd(), 'data');

const MEMORY_STORAGE_WARNING =
  'STORAGE_TYPE=memory: users and sessions are lost on restart; every restart returns to the register screen';

const PUBLIC_URL_WARNING =
  'Running in production without AUTH_PUBLIC_URL. Session cookies are not marked Secure, because ' +
  'nothing declares the scheme the browser uses, and sign-in is rejected with 403 when a reverse ' +
  'proxy rewrites the Host header without forwarding X-Forwarded-Host. Set AUTH_PUBLIC_URL to the ' +
  'browser-facing URL. TRUST_PROXY only makes forwarded headers trusted; it does not tell the API ' +
  'that the browser connection is HTTPS.';

const logger = new Logger('WorkspaceAuth');

function warnAboutPublicUrl(config: WorkspaceConfig): void {
  if (config.publicUrl !== null) {
    return;
  }
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  logger.warn(PUBLIC_URL_WARNING);
}

async function buildBetterAuth(
  storage: StoragePort,
  config: WorkspaceConfig,
): Promise<BetterAuthInstance> {
  if (hasRawDatabaseHandle(storage) === false) {
    throw new Error('Storage adapter does not expose a raw database handle');
  }
  const handle = storage.getRawDatabaseHandle();
  if (handle.kind === 'memory') {
    logger.warn(MEMORY_STORAGE_WARNING);
  }
  warnAboutPublicUrl(config);
  const secret = resolveAuthSecret(process.env, process.env.BETTERDB_DATA_DIR || DEFAULT_DATA_DIR);
  const auth = await createBetterAuth({ handle, secret, config });
  await runBetterAuthMigrations(auth, handle);
  return auth;
}

@Module({})
export class WorkspaceAuthModule {
  static forRoot(): DynamicModule {
    const config = resolveWorkspaceConfig(process.env);
    const providers: Provider[] = [
      { provide: WORKSPACE_CONFIG, useValue: config },
      ActorResolver,
      { provide: APP_GUARD, useClass: ActorGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: MutationGuard },
    ];
    const controllers: Type<unknown>[] = [];
    const exports: (string | Type<unknown>)[] = [WORKSPACE_CONFIG, ActorResolver];
    if (config.enabled === true) {
      providers.push({
        provide: BETTER_AUTH,
        useFactory: (storage: StoragePort) => {
          return buildBetterAuth(storage, config);
        },
        inject: ['STORAGE_CLIENT'],
      });
      providers.push({ provide: WORKSPACE_STATUS, useClass: WorkspaceStatusService });
      providers.push(MemberService, InvitationService);
      controllers.push(BetterAuthController, WorkspaceController, InviteController);
      exports.push(BETTER_AUTH, WORKSPACE_STATUS);
    }
    return {
      module: WorkspaceAuthModule,
      global: true,
      imports: [StorageModule, ActivityModule],
      providers,
      controllers,
      exports,
    };
  }
}
