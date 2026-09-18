import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Actor } from '@betterdb/shared';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { SystemModule } from '../system/system.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { WorkspaceAuthModule } from '../auth/workspace-auth.module';
import { SelfHostedAgentModule } from './self-hosted-agent.module';
import { PersonalTokensController } from '../workspace/personal-tokens.controller';

// Throwaway verification: boot the real module graph in self-hosted ENABLED mode
// with the self-hosted agent wiring, and confirm (a) DI resolves across module
// boundaries (AgentGateway needs the global ConnectionRegistry), (b) Fastify
// registers routes with no collision, (c) the injected gateway/token service work.
describe('self-hosted agent wiring (boot verification)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.STORAGE_TYPE = 'memory';
    process.env.AUTH_SECRET = 's'.repeat(40);
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.CLOUD_MODE;
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule,
        ConnectionsModule,
        SelfHostedAgentModule,
        WorkspaceAuthModule.forRoot(),
        SystemModule,
        TelemetryModule,
      ],
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
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('boots with no route collision and the connections route registered', async () => {
    // 404 would mean the route is missing; 401 means it registered and the auth
    // guard runs (self-hosted enabled requires a session).
    const res = await app.inject({ method: 'GET', url: '/agent-tokens/connections' });
    expect(res.statusCode).toBe(401);
  });

  it('injected AgentGateway resolves and returns live connections', () => {
    const controller = app.get(PersonalTokensController, { strict: false });
    expect(controller.getConnections()).toEqual([]);
  });

  it('injected AgentTokensService is available (agent list does not 503)', async () => {
    const controller = app.get(PersonalTokensController, { strict: false });
    const actor = { userId: 'u1', role: 'admin', via: 'session' } as unknown as Actor;
    await expect(controller.list(actor, 'agent')).resolves.toEqual([]);
  });
});
