/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { InferenceLatencyController } from '../inference-latency.controller';
import { InferenceLatencyService } from '../inference-latency.service';

describe('InferenceLatencyController', () => {
  let controller: InferenceLatencyController;
  let service: { getProfile: jest.Mock };

  const buildModule = (registry: Partial<ConnectionRegistry>): Promise<TestingModule> =>
    Test.createTestingModule({
      controllers: [InferenceLatencyController],
      providers: [
        { provide: InferenceLatencyService, useValue: service },
        { provide: ConnectionRegistry, useValue: registry },
      ],
    }).compile();

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
});
