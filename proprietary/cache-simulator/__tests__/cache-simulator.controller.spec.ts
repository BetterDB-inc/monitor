import { Feature } from '@betterdb/shared';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';
import { LicenseGuard } from '@proprietary/licenses';
import { CacheSimulatorController } from '../cache-simulator.controller';

describe('CacheSimulatorController', () => {
  const service = { snapshot: jest.fn().mockResolvedValue({ status: 'sampling' }) };
  const controller = new CacheSimulatorController(service as any);

  beforeEach(() => service.snapshot.mockClear());

  it('defaults the connection and refresh flag', async () => {
    await controller.getSnapshot(undefined, undefined);
    expect(service.snapshot).toHaveBeenCalledWith(ENV_DEFAULT_ID, false);
  });

  it('passes refresh=true through', async () => {
    await controller.getSnapshot('true', 'c1');
    expect(service.snapshot).toHaveBeenCalledWith('c1', true);
    await controller.getSnapshot('false', 'c1');
    expect(service.snapshot).toHaveBeenLastCalledWith('c1', false);
  });

  it('requires the Pro feature behind the license guard', () => {
    expect(Reflect.getMetadata('requiredFeature', CacheSimulatorController.prototype.getSnapshot)).toBe(Feature.CACHE_SIZE_SIMULATOR);
    expect(Reflect.getMetadata('__guards__', CacheSimulatorController.prototype.getSnapshot)).toContain(LicenseGuard);
  });
});
