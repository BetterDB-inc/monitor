import { HttpException, HttpStatus } from '@nestjs/common';
import { MetricsController } from '../metrics.controller';
import { SLOT_STATS_FAILED_NODES_HEADER } from '../metrics.service';

describe('MetricsController cluster slot stats', () => {
  const getClusterSlotStatsResult = jest.fn();
  const controller = Object.assign(Object.create(MetricsController.prototype), {
    metricsService: { getClusterSlotStatsResult },
  }) as MetricsController;

  beforeEach(() => getClusterSlotStatsResult.mockReset());

  it.each(['abc', '10oops', '0', '-1'])('rejects the invalid limit %p with 400 before querying the cluster', async (limit) => {
    const error = await controller.getClusterSlotStats(undefined, limit).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(getClusterSlotStatsResult).not.toHaveBeenCalled();
  });

  it('passes a numeric limit through and lists the primaries that did not answer', async () => {
    getClusterSlotStatsResult.mockResolvedValue({ stats: {}, failedNodes: ['10.0.0.1:6379'], failedSlotRanges: [] });
    const header = jest.fn();

    await controller.getClusterSlotStats('key-count', '10', 'conn-1', { header } as never);

    expect(getClusterSlotStatsResult).toHaveBeenCalledWith('key-count', 10, 'conn-1');
    expect(header).toHaveBeenCalledWith(SLOT_STATS_FAILED_NODES_HEADER, '10.0.0.1:6379');
  });
});
