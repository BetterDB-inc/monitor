import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { WorkspaceAuthModule } from '../src/auth/workspace-auth.module';
import { StorageModule } from '../src/storage/storage.module';
import { SystemModule } from '../src/system/system.module';
import { TelemetryModule } from '../src/telemetry/telemetry.module';
import { UsageTelemetryService } from '../src/telemetry/usage-telemetry.service';

export async function boot(
  env: Record<string, string | undefined>,
): Promise<NestFastifyApplication> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule, WorkspaceAuthModule.forRoot(), SystemModule, TelemetryModule],
  })
    .overrideProvider(UsageTelemetryService)
    .useValue({
      trackUserInvited: jest.fn(),
      trackInviteAccepted: jest.fn(),
      trackAppStart: jest.fn(),
      trackUserLogin: jest.fn(),
      trackWorkspaceFirstRegister: jest.fn(),
      trackMemberRemoved: jest.fn(),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
