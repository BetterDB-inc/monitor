import { UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Actor, DetailedHealthResponse, HealthResponse } from '@betterdb/shared';
import { ActorResolver } from '../../auth/actor-resolver';
import { isActorOptionalPath } from '../../auth/guards/public-paths';
import { ActorGuard, type RequestWithActor } from '../../auth/guards/actor.guard';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../../auth/workspace-config';
import { HealthController } from '../health.controller';
import { HealthService } from '../health.service';
import { redactDetailedHealth, redactHealth } from '../health-redaction';

const FULL: HealthResponse = {
  status: 'connected',
  database: { type: 'valkey', version: '8.0.1', host: 'cache-primary.internal', port: 6379 },
  capabilities: { dbType: 'valkey', version: '8.0.1' } as HealthResponse['capabilities'],
  runtimeCapabilities: null,
};
const DETAILED: DetailedHealthResponse = {
  ...FULL,
  uptime: 42,
  timestamp: 1,
  license: { isValidated: true, tier: 'pro' } as DetailedHealthResponse['license'],
  configHazards: [
    { id: 'cluster-crc-disabled', severity: 'warning', status: 'hazard', message: 'm' },
  ],
};

function mockService(): HealthService {
  return {
    getHealth: jest.fn().mockResolvedValue(FULL),
    getDetailedHealth: jest.fn().mockResolvedValue(DETAILED),
    getAllConnectionsHealth: jest
      .fn()
      .mockResolvedValue({ overallStatus: 'healthy', connections: [], timestamp: 1 }),
  } as unknown as HealthService;
}

function controller(enabled: boolean) {
  return new HealthController(mockService(), { enabled } as WorkspaceConfig);
}

const anonymous = { actor: null } as RequestWithActor;
const signedIn = { actor: { userId: 'u1', role: 'member' } } as unknown as RequestWithActor;

describe('HealthController when sign-in is enforced', () => {
  it('resolves an optional actor on every health path', () => {
    for (const path of ['/api/health', '/api/health/all', '/api/health/detailed']) {
      expect(isActorOptionalPath(path)).toBe(true);
    }
  });

  it('tells an anonymous caller only that the server is up', async () => {
    const body = await controller(true).getHealth(anonymous);
    expect(body).toEqual({
      status: 'connected',
      database: { type: 'unknown', version: null, host: '', port: 0 },
      capabilities: null,
    });
  });

  it('keeps the startup guard working for anonymous callers without leaking topology', async () => {
    const body = await controller(true).getDetailedHealth(anonymous);
    expect(body.license).toEqual({ isValidated: true });
    expect(JSON.stringify(body)).not.toContain('cache-primary.internal');
    expect(JSON.stringify(body)).not.toContain('8.0.1');
    expect(body.configHazards).toBeUndefined();
  });

  it('refuses the all-connections listing to anonymous callers', async () => {
    await expect(controller(true).getAllConnectionsHealth(anonymous)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('serves full responses to a signed-in actor', async () => {
    const c = controller(true);
    expect(await c.getHealth(signedIn)).toEqual(FULL);
    expect(await c.getDetailedHealth(signedIn)).toEqual(DETAILED);
  });

  it('is unchanged when workspace auth is disabled', async () => {
    expect(await controller(false).getHealth(anonymous)).toEqual(FULL);
  });
});

describe('health redaction', () => {
  it('keeps the top-level status on both shapes', () => {
    expect(redactHealth({ ...FULL, status: 'disconnected' }).status).toBe('disconnected');
    expect(redactDetailedHealth({ ...DETAILED, status: 'error' }).status).toBe('error');
  });

  it('keeps license.isValidated for the pre-sign-in ServerStartupGuard', () => {
    const pending = { ...DETAILED, license: { isValidated: false, tier: 'pro' } };
    expect(redactDetailedHealth(DETAILED as DetailedHealthResponse).license).toEqual({
      isValidated: true,
    });
    expect(
      redactDetailedHealth(pending as unknown as DetailedHealthResponse).license,
    ).toEqual({ isValidated: false });
  });

  it('drops tier, hazards, runtime capabilities and connection details', () => {
    const body = redactDetailedHealth(DETAILED);
    expect(body.license).not.toHaveProperty('tier');
    expect(body).not.toHaveProperty('configHazards');
    expect(body).not.toHaveProperty('runtimeCapabilities');
    expect(body.capabilities).toBeNull();
    expect(body.database).toEqual({ type: 'unknown', version: null, host: '', port: 0 });
  });
});

describe('health endpoints over HTTP when sign-in is enforced', () => {
  const member = { userId: 'u1', role: 'member', via: 'bearer' } as unknown as Actor;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const resolver = {
      isEnabled: () => true,
      isReady: () => true,
      resolveFromHeaders: jest.fn(async (headers: Record<string, unknown>) => {
        return headers.authorization === 'Bearer good' ? member : null;
      }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useValue: mockService() },
        { provide: WORKSPACE_CONFIG, useValue: { enabled: true } },
        { provide: ActorResolver, useValue: resolver },
        { provide: APP_GUARD, useClass: ActorGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an anonymous probe on /health with 200 and no topology', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'connected',
      database: { type: 'unknown', version: null, host: '', port: 0 },
      capabilities: null,
    });
  });

  it('answers HEAD /health with 200 for probes that only read the status code', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('answers anonymous /health/detailed with 200 and license.isValidated', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/detailed' });
    expect(response.statusCode).toBe(200);
    expect(response.json().license).toEqual({ isValidated: true });
    expect(response.body).not.toContain('cache-primary.internal');
  });

  it('answers anonymous /health/all with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/all' });
    expect(response.statusCode).toBe(401);
  });

  it('resolves a bearer on the public health path and serves the full body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/detailed',
      headers: { authorization: 'Bearer good' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().database.host).toBe('cache-primary.internal');
    const all = await app.inject({
      method: 'GET',
      url: '/health/all',
      headers: { authorization: 'Bearer good' },
    });
    expect(all.statusCode).toBe(200);
  });

  it('treats an invalid bearer as anonymous rather than rejecting the probe', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer bad' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().database.host).toBe('');
  });
});
