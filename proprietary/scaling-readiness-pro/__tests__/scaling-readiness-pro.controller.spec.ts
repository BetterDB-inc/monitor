import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Feature } from '@betterdb/shared';
import { ScalingReadinessProController } from '../scaling-readiness-pro.controller';
import { ENV_DEFAULT_ID } from '@app/connections/connection-registry.service';

describe('ScalingReadinessProController', () => {
  const service = {
    getHistory: jest.fn().mockResolvedValue({ points: [] }),
    getSettings: jest.fn().mockResolvedValue({}),
    updateSettings: jest.fn().mockResolvedValue({}),
  };
  const controller = new ScalingReadinessProController(service as any);

  it('parses the history range', async () => {
    await controller.getHistory('100', '200', 'conn-1');
    expect(service.getHistory).toHaveBeenCalledWith('conn-1', 100, 200);
  });

  it('rejects a non-numeric range', async () => {
    await expect(controller.getHistory('abc', '200', 'conn-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('defaults the connection for settings', async () => {
    await controller.getSettings(undefined);
    expect(service.getSettings).toHaveBeenCalledWith(ENV_DEFAULT_ID);
  });

  it('requires the scaling readiness history feature on every route', () => {
    const reflector = new Reflector();
    for (const handler of ['getHistory', 'getSettings', 'updateSettings'] as const) {
      const feature = reflector.get('requiredFeature', ScalingReadinessProController.prototype[handler]);
      expect(feature).toEqual(Feature.SCALING_READINESS_HISTORY);
    }
  });
});
