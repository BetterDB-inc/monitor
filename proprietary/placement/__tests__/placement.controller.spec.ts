import { BadRequestException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Actor } from '@betterdb/shared';
import { MutationGuard, READ_ONLY_MESSAGE } from '@app/auth/guards/mutation.guard';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '@app/auth/workspace-config';
import { PlacementController, McpPlacementController } from '../placement.controller';
import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import {
  PlacementModeError,
  PlacementPolicyConflictError,
  PlacementPolicyError,
  PlacementService,
} from '../placement.service';

jest.mock('@proprietary/licenses', () => ({
  LicenseGuard: class {
    canActivate() {
      return true;
    }
  },
  RequiresFeature: () => () => undefined,
  Feature: { ANOMALY_DETECTION: 'anomaly-detection' },
}));

const status = { connectionId: 'seed', mode: 'recommend' };

function placement() {
  return {
    getStatus: jest.fn().mockResolvedValue(status),
    setMode: jest.fn().mockResolvedValue(status),
    setSettings: jest.fn().mockResolvedValue(status),
  };
}

describe('PlacementController', () => {
  it('returns the placement status of the connection', async () => {
    const service = placement();
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(controller.getStatus('c1')).resolves.toBe(status);
    expect(service.getStatus).toHaveBeenCalledWith('c1');
  });

  it('sets a known mode', async () => {
    const service = placement();
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(controller.setMode('c1', { mode: 'recommend' })).resolves.toBe(status);
    expect(service.setMode).toHaveBeenCalledWith('c1', 'recommend');
  });

  it.each([[{}], [{ mode: 'turbo' }], [null], ['recommend']])('rejects the body %j', async (body) => {
    const controller = new PlacementController(placement() as unknown as PlacementService);
    await expect(controller.setMode('c1', body)).rejects.toThrow(BadRequestException);
  });

  it('answers 400 with the reason when the mode is refused', async () => {
    const service = placement();
    service.setMode.mockRejectedValue(new PlacementModeError('Slot placement needs cluster mode.', 'not_cluster'));
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(controller.setMode('c1', { mode: 'recommend' })).rejects.toMatchObject({
      response: { message: 'Slot placement needs cluster mode.', blockedBy: 'not_cluster' },
    });
  });
});

describe('PlacementController policy', () => {
  it('saves the policy at the version it read', async () => {
    const service = placement();
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(
      controller.setPolicy('c1', { policy: DEFAULT_PLACEMENT_SETTINGS, version: 3 }),
    ).resolves.toBe(status);
    expect(service.setSettings).toHaveBeenCalledWith('c1', DEFAULT_PLACEMENT_SETTINGS, 3);
  });

  it.each([
    [{}],
    [{ policy: {} }],
    [{ policy: {}, version: -1 }],
    [{ policy: {}, version: 1.5 }],
    [{ policy: {}, version: 2_147_483_648 }],
    [null],
  ])('rejects the body %j', async (body) => {
    const controller = new PlacementController(placement() as unknown as PlacementService);
    await expect(controller.setPolicy('c1', body)).rejects.toThrow(BadRequestException);
  });

  it('answers 400 with the validation errors', async () => {
    const service = placement();
    service.setSettings.mockRejectedValue(
      new PlacementPolicyError(['resolveRatio: must be below triggerRatio']),
    );
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(controller.setPolicy('c1', { policy: {}, version: 0 })).rejects.toMatchObject({
      status: 400,
      response: { errors: ['resolveRatio: must be below triggerRatio'] },
    });
  });

  it('answers 409 when the policy changed since it was read', async () => {
    const service = placement();
    service.setSettings.mockRejectedValue(new PlacementPolicyConflictError());
    const controller = new PlacementController(service as unknown as PlacementService);
    await expect(controller.setPolicy('c1', { policy: {}, version: 0 })).rejects.toMatchObject({
      status: 409,
      response: { reason: 'version_conflict' },
    });
  });
});

describe('McpPlacementController', () => {
  it('returns the placement status for an instance', async () => {
    const service = placement();
    const registry = { get: jest.fn() };
    const controller = new McpPlacementController(service as unknown as PlacementService, registry as never);
    await expect(controller.getStatus('c1')).resolves.toBe(status);
    expect(registry.get).toHaveBeenCalledWith('c1');
  });
});

describe('PlacementController roles', () => {
  const workspace = { enabled: true } as WorkspaceConfig;
  const actor = (role: Actor['role']): Actor => ({
    userId: role,
    email: `${role}@x`,
    role,
    isOwner: false,
    via: 'session',
    tokenId: null,
  });
  let app: NestFastifyApplication;
  let service: ReturnType<typeof placement>;
  let signedIn: Actor;

  beforeEach(async () => {
    service = placement();
    const mod = await Test.createTestingModule({
      controllers: [PlacementController],
      providers: [
        { provide: PlacementService, useValue: service },
        { provide: WORKSPACE_CONFIG, useValue: workspace },
        { provide: APP_GUARD, useClass: MutationGuard },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (req: unknown) => {
        (req as { actor?: Actor }).actor = signedIn;
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => app.close());

  const putMode = () =>
    app.inject({
      method: 'PUT',
      url: '/anomaly/placement/mode',
      headers: { 'x-connection-id': 'c1' },
      payload: { mode: 'observe' },
    });

  it('refuses a member changing the mode', async () => {
    signedIn = actor('member');
    const res = await putMode();
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(READ_ONLY_MESSAGE);
    expect(service.setMode).not.toHaveBeenCalled();
  });

  it('refuses a member changing the policy and lets an admin', async () => {
    const putPolicy = () =>
      app.inject({
        method: 'PUT',
        url: '/anomaly/placement/policy',
        headers: { 'x-connection-id': 'c1' },
        payload: { policy: DEFAULT_PLACEMENT_SETTINGS, version: 0 },
      });
    signedIn = actor('member');
    expect((await putPolicy()).statusCode).toBe(403);
    expect(service.setSettings).not.toHaveBeenCalled();
    signedIn = actor('admin');
    expect((await putPolicy()).statusCode).toBe(200);
    expect(service.setSettings).toHaveBeenCalledWith('c1', DEFAULT_PLACEMENT_SETTINGS, 0);
  });

  it('lets a member read the status and an admin change the mode', async () => {
    signedIn = actor('member');
    const read = await app.inject({ method: 'GET', url: '/anomaly/placement', headers: { 'x-connection-id': 'c1' } });
    expect(read.statusCode).toBe(200);
    signedIn = actor('admin');
    expect((await putMode()).statusCode).toBe(200);
    expect(service.setMode).toHaveBeenCalledWith('c1', 'observe');
  });
});
