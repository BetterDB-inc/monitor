import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'path';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { hasRawDatabaseHandle } from '../storage/raw-database-handle';
import { StorageModule } from '../storage/storage.module';
import { WorkspaceController } from '../workspace/workspace.controller';
import { WORKSPACE_STATUS, WorkspaceStatusService } from '../workspace/workspace-status.service';
import { resolveAuthSecret } from './auth-secret';
import { BetterAuthController } from './better-auth.controller';
import {
  BETTER_AUTH,
  BetterAuthInstance,
  createBetterAuth,
  runBetterAuthMigrations,
} from './better-auth.factory';
import { ActorGuard } from './guards/actor.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG, WorkspaceConfig } from './workspace-config';

const DEFAULT_DATA_DIR = join(process.cwd(), 'data');

async function buildBetterAuth(
  storage: StoragePort,
  config: WorkspaceConfig,
): Promise<BetterAuthInstance> {
  if (hasRawDatabaseHandle(storage) === false) {
    throw new Error('Storage adapter does not expose a raw database handle');
  }
  const handle = storage.getRawDatabaseHandle();
  const secret = resolveAuthSecret(process.env, process.env.BETTERDB_DATA_DIR ?? DEFAULT_DATA_DIR);
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
      { provide: APP_GUARD, useClass: ActorGuard },
    ];
    const controllers: Type<unknown>[] = [];
    const exports: string[] = [WORKSPACE_CONFIG];
    if (config.enabled) {
      providers.push({
        provide: BETTER_AUTH,
        useFactory: (storage: StoragePort) => {
          return buildBetterAuth(storage, config);
        },
        inject: ['STORAGE_CLIENT'],
      });
      providers.push({ provide: WORKSPACE_STATUS, useClass: WorkspaceStatusService });
      controllers.push(BetterAuthController, WorkspaceController);
      exports.push(BETTER_AUTH, WORKSPACE_STATUS);
    }
    return {
      module: WorkspaceAuthModule,
      global: true,
      imports: [StorageModule],
      providers,
      controllers,
      exports,
    };
  }
}
