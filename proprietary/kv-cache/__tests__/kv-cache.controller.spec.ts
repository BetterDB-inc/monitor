import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '@betterdb/shared';
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
  const registry = {
    getDefaultId: jest.fn().mockReturnValue('ui-added'),
    get: jest.fn((id: string) => {
      if (id === 'nope') throw new NotFoundException(`Connection '${id}' not found`);
      return {};
    }),
  };
  const controller = new KvCacheController(status as any, footprint as any, registry as any, engines as any, samples as any, alerts as any);

  it('defaults to the registry default connection on every route', async () => {
    await controller.getStatus(undefined);
    expect(status.getStatus).toHaveBeenLastCalledWith('ui-added');
    await controller.refreshFootprint(undefined);
    expect(footprint.triggerCollection).toHaveBeenLastCalledWith('ui-added');
    await controller.getFootprintHistory('100', '200', undefined);
    expect(status.getFootprintHistory).toHaveBeenLastCalledWith('ui-added', 100, 200);
  });

  it('returns a 404 when no default connection exists', async () => {
    registry.getDefaultId.mockReturnValueOnce(null);
    await expect(controller.getStatus(undefined)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown explicit connection id', async () => {
    await expect(controller.getStatus('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refreshes the footprint for the connection', async () => {
    await controller.refreshFootprint('c1');
    expect(footprint.triggerCollection).toHaveBeenCalledWith('c1');
  });

  it('propagates a not-found connection as a 404', async () => {
    footprint.triggerCollection.mockRejectedValueOnce(new NotFoundException("Connection 'nope' not found"));
    await expect(controller.refreshFootprint('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('parses and validates the history range', async () => {
    await controller.getFootprintHistory('100', '200', 'c1');
    expect(status.getFootprintHistory).toHaveBeenCalledWith('c1', 100, 200);
    await expect(controller.getFootprintHistory('200', '100', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getFootprintHistory(undefined, '100', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('routes engine calls to the configured default connection', async () => {
    controller.listEngines(undefined);
    expect(engines.list).toHaveBeenCalledWith('ui-added');
    const dto = { name: 'n', source: 'otlp' } as any;
    await controller.createEngine(dto, undefined);
    expect(engines.create).toHaveBeenCalledWith('ui-added', dto);
    await controller.updateEngine('e1', { enabled: false }, undefined);
    expect(engines.update).toHaveBeenCalledWith('ui-added', 'e1', { enabled: false });
    await controller.removeEngine('e1', 'c1');
    expect(engines.remove).toHaveBeenCalledWith('c1', 'e1');
  });

  it('parses the samples range and forwards the filters', async () => {
    await controller.getSamples('100', '200', 'e1', 'm', 'c1');
    expect(samples.getSamples).toHaveBeenCalledWith('c1', { from: 100, to: 200, engineId: 'e1', model: 'm' });
    await controller.getSamples('100', '200', undefined, undefined, undefined);
    expect(samples.getSamples).toHaveBeenLastCalledWith('ui-added', { from: 100, to: 200, engineId: undefined, model: undefined });
    await expect(controller.getSamples('200', '100', undefined, undefined, 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('routes settings calls to the connection', async () => {
    await controller.getSettings(undefined);
    expect(alerts.getSettings).toHaveBeenCalledWith('ui-added');
    await controller.updateSettings({ hitRateThreshold: 0.3 }, 'c1');
    expect(alerts.updateSettings).toHaveBeenCalledWith('c1', { hitRateThreshold: 0.3 });
  });

  it('rejects engine, sample and settings calls for an unknown connection', async () => {
    jest.clearAllMocks();
    expect(() => controller.listEngines('nope')).toThrow(NotFoundException);
    await expect(controller.createEngine({ name: 'n', source: 'otlp' } as any, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.updateEngine('e1', {}, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.removeEngine('e1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.getSamples('100', '200', undefined, undefined, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.getSettings('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.updateSettings({}, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(engines.create).not.toHaveBeenCalled();
    expect(alerts.updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['a fractional timestamp', '100', '1700000000000.5'],
    ['a timestamp beyond the safe integer range', '100', '1e19'],
  ])('rejects %s with a 400', async (_label, from, to) => {
    await expect(controller.getFootprintHistory(from, to, 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the KV cache feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getStatus', 'refreshFootprint', 'getFootprintHistory', 'getSamples', 'listEngines', 'createEngine', 'updateEngine', 'removeEngine', 'getSettings', 'updateSettings'] as const) {
      expect(reflector.get('requiredFeature', KvCacheController.prototype[handler])).toEqual(Feature.KV_CACHE_MONITORING);
    }
  });
});
