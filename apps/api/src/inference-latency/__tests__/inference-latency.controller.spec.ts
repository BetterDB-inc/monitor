/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LicenseGuard } from '@proprietary/licenses';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { InferenceLatencyController } from '../inference-latency.controller';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from '../inference-latency.service';

class AllowingGuard {
  canActivate(): boolean {
    return true;
  }
}

describe('InferenceLatencyController', () => {
  let controller: InferenceLatencyController;
  let service: { getProfile: jest.Mock; getTrend: jest.Mock };

  const buildModule = (registry: Partial<ConnectionRegistry>): Promise<TestingModule> =>
    Test.createTestingModule({
      controllers: [InferenceLatencyController],
      providers: [
        { provide: InferenceLatencyService, useValue: service },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    })
      .overrideGuard(LicenseGuard)
      .useClass(AllowingGuard)
      .compile();

  const registry = (
    known: string[],
    defaultId: string | null = 'default-conn',
  ): Partial<ConnectionRegistry> => ({
    get: jest.fn((id: string) => {
      if (!known.includes(id)) throw new NotFoundException(`Connection '${id}' not found.`);
      return {} as any;
    }),
    getDefaultId: jest.fn().mockReturnValue(defaultId),
  });

  beforeEach(async () => {
    service = {
      getProfile: jest.fn().mockResolvedValue({ buckets: [] }),
      getTrend: jest.fn().mockResolvedValue({ points: [] }),
    };
    const module = await buildModule(registry(['conn-1'], 'default-conn') as any);
    controller = module.get(InferenceLatencyController);
  });

  describe('GET /profile', () => {
    it('coerces windowMs to a number before delegating', async () => {
      await controller.getProfile('900000', undefined, undefined, 'conn-1');
      expect(service.getProfile).toHaveBeenCalledWith('conn-1', {
        windowMs: 900000,
        startTime: undefined,
        endTime: undefined,
      });
    });

    it('passes explicit startTime/endTime through', async () => {
      await controller.getProfile(undefined, '1000', '2000', 'conn-1');
      expect(service.getProfile).toHaveBeenCalledWith('conn-1', {
        windowMs: undefined,
        startTime: 1000,
        endTime: 2000,
      });
    });

    it('rejects startTime without endTime', async () => {
      await expect(
        controller.getProfile(undefined, '1000', undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-numeric time params', async () => {
      await expect(
        controller.getProfile(undefined, 'nope', '2000', 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falls back to the default connection when no header is provided', async () => {
      await controller.getProfile(undefined, undefined, undefined, undefined);
      expect(service.getProfile).toHaveBeenCalledWith('default-conn', {
        windowMs: undefined,
        startTime: undefined,
        endTime: undefined,
      });
    });

    it('returns 404 for an unknown explicit connection id', async () => {
      await expect(
        controller.getProfile(undefined, undefined, undefined, 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 404 when no connection is registered and none is supplied', async () => {
      const module = await buildModule(registry([], null) as any);
      const fallbackController = module.get(InferenceLatencyController);
      await expect(
        fallbackController.getProfile(undefined, undefined, undefined, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET /trend', () => {
    it('requires bucket, startTime, and endTime', async () => {
      await expect(
        controller.getTrend(undefined, '1', '2', undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.getTrend('FT.SEARCH:idx', undefined, '2', undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.getTrend('FT.SEARCH:idx', '1', undefined, undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-numeric time params', async () => {
      await expect(
        controller.getTrend('FT.SEARCH:idx', 'not-a-number', '2', undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-positive bucketMs', async () => {
      await expect(
        controller.getTrend('FT.SEARCH:idx', '1', '2', '-5', 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delegates valid input to the service', async () => {
      await controller.getTrend('FT.SEARCH:idx', '100', '900', '60000', 'conn-1');
      expect(service.getTrend).toHaveBeenCalledWith('conn-1', 'FT.SEARCH:idx', 100, 900, 60000);
    });

    it('translates InferenceLatencyValidationError to 400', async () => {
      service.getTrend.mockRejectedValueOnce(
        new InferenceLatencyValidationError('bin cap exceeded'),
      );
      await expect(
        controller.getTrend('FT.SEARCH:idx', '100', '900', undefined, 'conn-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets non-validation service errors propagate (5xx path)', async () => {
      const boom = new Error('ECONNRESET');
      service.getTrend.mockRejectedValueOnce(boom);
      await expect(
        controller.getTrend('FT.SEARCH:idx', '100', '900', undefined, 'conn-1'),
      ).rejects.toBe(boom);
    });
  });
});
