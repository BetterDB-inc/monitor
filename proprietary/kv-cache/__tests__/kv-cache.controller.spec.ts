import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '@betterdb/shared';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { KvCacheController } from '../kv-cache.controller';

describe('KvCacheController', () => {
  const status = { getStatus: jest.fn().mockResolvedValue({}), getFootprintHistory: jest.fn().mockResolvedValue([]) };
  const footprint = { triggerCollection: jest.fn().mockResolvedValue(null) };
  const engines = {
    list: jest.fn().mockReturnValue([]),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new KvCacheController(status as any, footprint as any, engines as any);

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

  it('routes engine calls to the default connection', async () => {
    controller.listEngines(undefined);
    expect(engines.list).toHaveBeenCalledWith(ENV_DEFAULT_ID);
    const dto = { name: 'n', source: 'otlp' } as any;
    await controller.createEngine(dto, undefined);
    expect(engines.create).toHaveBeenCalledWith(ENV_DEFAULT_ID, dto);
    await controller.updateEngine('e1', { enabled: false }, undefined);
    expect(engines.update).toHaveBeenCalledWith(ENV_DEFAULT_ID, 'e1', { enabled: false });
    await controller.removeEngine('e1', 'c1');
    expect(engines.remove).toHaveBeenCalledWith('c1', 'e1');
  });

  it('requires the KV cache feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getStatus', 'refreshFootprint', 'getFootprintHistory', 'listEngines', 'createEngine', 'updateEngine', 'removeEngine'] as const) {
      expect(reflector.get('requiredFeature', KvCacheController.prototype[handler])).toEqual(Feature.KV_CACHE_MONITORING);
    }
  });
});
