import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import type { Actor } from '@betterdb/shared';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { SystemModule } from '../system/system.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { WorkspaceAuthModule } from '../auth/workspace-auth.module';
import { PersonalTokensController } from '../workspace/personal-tokens.controller';

// Boot the real module graph in self-hosted ENABLED mode with the self-hosted agent
// wiring, and confirm (a) DI resolves across module boundaries (AgentGateway needs
// the global ConnectionRegistry), (b) Fastify registers routes with no collision,
// (c) the injected gateway/token service work, (d) agent minting succeeds with no
// preconfigured SESSION_SECRET.
describe('self-hosted agent wiring (boot verification)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.STORAGE_TYPE = 'memory';
    process.env.AUTH_SECRET = 's'.repeat(40);
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.CLOUD_MODE;
    // Clear any inherited SESSION_SECRET, then load the module so its import-time
    // seeding runs against this controlled env — otherwise the mint test below could
    // pass on an inherited secret and mask a seeding regression.
    delete process.env.SESSION_SECRET;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SelfHostedAgentModule } = require('./self-hosted-agent.module');
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

  // Regression: agent-token JWTs are signed with SESSION_SECRET, which is unset on a
  // standard self-hosted instance (auth uses AUTH_SECRET). jsonwebtoken throws on an
  // empty secret, so without the module seeding SESSION_SECRET this mint would 500.
  it('mints an agent token without SESSION_SECRET set', async () => {
    const controller = app.get(PersonalTokensController, { strict: false });
    const actor = {
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      isOwner: true,
      via: 'session',
    } as unknown as Actor;
    const req = { headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest;
    const result = await controller.create({ name: 'ci-agent', type: 'agent' }, actor, req);
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.type).toBe('agent');
  });
});
