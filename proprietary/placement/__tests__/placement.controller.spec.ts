import { BadRequestException } from '@nestjs/common';
import { PlacementController, McpPlacementController } from '../placement.controller';
import { PlacementModeError, type PlacementService } from '../placement.service';

jest.mock('@proprietary/licenses', () => ({
  LicenseGuard: class {},
  RequiresFeature: () => () => undefined,
  Feature: { ANOMALY_DETECTION: 'anomaly-detection' },
}));

const status = { connectionId: 'seed', mode: 'recommend' };

function placement() {
  return {
    getStatus: jest.fn().mockResolvedValue(status),
    setMode: jest.fn().mockResolvedValue(status),
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

describe('McpPlacementController', () => {
  it('returns the placement status for an instance', async () => {
    const service = placement();
    const registry = { get: jest.fn() };
    const controller = new McpPlacementController(service as unknown as PlacementService, registry as never);
    await expect(controller.getStatus('c1')).resolves.toBe(status);
    expect(registry.get).toHaveBeenCalledWith('c1');
  });
});
