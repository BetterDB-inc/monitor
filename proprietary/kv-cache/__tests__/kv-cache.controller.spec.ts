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
  const samples = { getSamples: jest.fn().mockResolvedValue({ buckets: [], rangeHitRate: null }) };
  const alerts = { getSettings: jest.fn().mockResolvedValue({}), updateSettings: jest.fn().mockResolvedValue({}) };
  const controller = new KvCacheController(status as any, footprint as any, engines as any, samples as any, alerts as any);

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

  it('parses the samples range and forwards the filters', async () => {
    await controller.getSamples('100', '200', 'e1', 'm', 'c1');
    expect(samples.getSamples).toHaveBeenCalledWith('c1', { from: 100, to: 200, engineId: 'e1', model: 'm' });
    await controller.getSamples('100', '200', undefined, undefined, undefined);
    expect(samples.getSamples).toHaveBeenLastCalledWith(ENV_DEFAULT_ID, { from: 100, to: 200, engineId: undefined, model: undefined });
    await expect(controller.getSamples('200', '100', undefined, undefined, 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('routes settings calls to the connection', async () => {
    await controller.getSettings(undefined);
    expect(alerts.getSettings).toHaveBeenCalledWith(ENV_DEFAULT_ID);
    await controller.updateSettings({ hitRateThreshold: 0.3 }, 'c1');
    expect(alerts.updateSettings).toHaveBeenCalledWith('c1', { hitRateThreshold: 0.3 });
  });

  it('requires the KV cache feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getStatus', 'refreshFootprint', 'getFootprintHistory', 'getSamples', 'listEngines', 'createEngine', 'updateEngine', 'removeEngine', 'getSettings', 'updateSettings'] as const) {
      expect(reflector.get('requiredFeature', KvCacheController.prototype[handler])).toEqual(Feature.KV_CACHE_MONITORING);
    }
  });
});
