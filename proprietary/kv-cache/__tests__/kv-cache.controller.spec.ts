import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '@betterdb/shared';
import { ALLOW_MEMBERS_KEY } from '@app/auth/guards/roles.decorator';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { KvCacheController } from '../kv-cache.controller';

describe('KvCacheController', () => {
  const status = { getStatus: jest.fn().mockResolvedValue({}), getFootprintHistory: jest.fn().mockResolvedValue([]) };
  const footprint = { triggerCollection: jest.fn().mockResolvedValue(null) };
  const controller = new KvCacheController(status as any, footprint as any);

  it('defaults the connection', async () => {
    await controller.getStatus(undefined);
    expect(status.getStatus).toHaveBeenCalledWith(ENV_DEFAULT_ID);
  });

  it('refreshes the footprint for the connection', async () => {
    await controller.refreshFootprint('c1');
    expect(footprint.triggerCollection).toHaveBeenCalledWith('c1');
  });

  it('parses and validates the history range', async () => {
    await controller.getFootprintHistory('100', '200', 'c1');
    expect(status.getFootprintHistory).toHaveBeenCalledWith('c1', 100, 200);
    await expect(controller.getFootprintHistory('200', '100', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getFootprintHistory(undefined, '100', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the KV cache feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getStatus', 'refreshFootprint', 'getFootprintHistory'] as const) {
      expect(reflector.get('requiredFeature', KvCacheController.prototype[handler])).toEqual(Feature.KV_CACHE_MONITORING);
    }
  });

  it('lets workspace members trigger a footprint refresh', () => {
    const reflector = new Reflector();
    expect(reflector.get(ALLOW_MEMBERS_KEY, KvCacheController.prototype.refreshFootprint)).toBe(true);
  });
});
