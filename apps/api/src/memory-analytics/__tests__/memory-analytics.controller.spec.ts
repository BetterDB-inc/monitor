import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MemoryAnalyticsController } from '../memory-analytics.controller';
import { MemoryAnalyticsService } from '../memory-analytics.service';

describe('MemoryAnalyticsController', () => {
  let controller: MemoryAnalyticsController;
  let service: jest.Mocked<Pick<MemoryAnalyticsService, 'getStoredSnapshots'>>;

  beforeEach(async () => {
    service = {
      getStoredSnapshots: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoryAnalyticsController],
      providers: [
        { provide: MemoryAnalyticsService, useValue: service },
      ],
    }).compile();

    controller = module.get<MemoryAnalyticsController>(MemoryAnalyticsController);
  });

  it('should pass parsed query params to service', async () => {
    await controller.getSnapshots('conn-1', '1000', '2000', '50', '10');

    expect(service.getStoredSnapshots).toHaveBeenCalledWith({
      startTime: 1000,
      endTime: 2000,
      limit: 50,
      offset: 10,
      connectionId: 'conn-1',
    });
  });

  it('should use defaults when no params are provided', async () => {
    await controller.getSnapshots(undefined, undefined, undefined, undefined, undefined);

    expect(service.getStoredSnapshots).toHaveBeenCalledWith({
      startTime: undefined,
      endTime: undefined,
      limit: 100,
      offset: 0,
      connectionId: undefined,
    });
  });

  it('should throw BadRequestException for non-numeric startTime', async () => {
    await expect(
      controller.getSnapshots(undefined, 'abc', undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException for non-numeric endTime', async () => {
    await expect(
      controller.getSnapshots(undefined, undefined, 'xyz', undefined, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException for non-numeric limit', async () => {
    await expect(
      controller.getSnapshots(undefined, undefined, undefined, 'bad', undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException for non-numeric offset', async () => {
    await expect(
      controller.getSnapshots(undefined, undefined, undefined, undefined, 'bad'),
    ).rejects.toThrow(BadRequestException);
  });
});
