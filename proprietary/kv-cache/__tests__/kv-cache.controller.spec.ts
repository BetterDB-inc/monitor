import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '@betterdb/shared';
import { KvCacheController } from '../kv-cache.controller';

describe('KvCacheController', () => {
  const status = { getStatus: jest.fn().mockResolvedValue({}), getFootprintHistory: jest.fn().mockResolvedValue([]) };
  const footprint = { triggerCollection: jest.fn().mockResolvedValue(null) };
  const registry = {
    getDefaultId: jest.fn().mockReturnValue('ui-added'),
    get: jest.fn((id: string) => {
      if (id === 'nope') throw new NotFoundException(`Connection '${id}' not found`);
      return {};
    }),
  };
  const controller = new KvCacheController(status as any, footprint as any, registry as any);

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

  it.each([
    ['a fractional timestamp', '100', '1700000000000.5'],
    ['a timestamp beyond the safe integer range', '100', '1e19'],
  ])('rejects %s with a 400', async (_label, from, to) => {
    await expect(controller.getFootprintHistory(from, to, 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the KV cache feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getStatus', 'refreshFootprint', 'getFootprintHistory'] as const) {
      expect(reflector.get('requiredFeature', KvCacheController.prototype[handler])).toEqual(Feature.KV_CACHE_MONITORING);
    }
  });
});
