/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LicenseGuard } from '@proprietary/licenses';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from '@app/inference-latency/inference-latency.service';
import { InferenceLatencyProController } from '../inference-latency-pro.controller';

class AllowingGuard {
  canActivate(): boolean {
    return true;
  }
}

describe('InferenceLatencyProController', () => {
  let controller: InferenceLatencyProController;
  let service: { getTrend: jest.Mock };

  const buildModule = (registry: Partial<ConnectionRegistry>): Promise<TestingModule> =>
    Test.createTestingModule({
      controllers: [InferenceLatencyProController],
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
      getTrend: jest.fn().mockResolvedValue({ points: [] }),
    };
    const module = await buildModule(registry(['conn-1'], 'default-conn') as any);
    controller = module.get(InferenceLatencyProController);
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
