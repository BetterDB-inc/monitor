import { Logger } from '@nestjs/common';
import { ActivityPruneJob, PRUNE_INTERVAL_MS } from './activity-prune.job';
import type { ActivityService } from './activity.service';

function serviceWith(prune: jest.Mock): ActivityService {
  return { prune } as unknown as ActivityService;
}

describe('ActivityPruneJob', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('prunes once at bootstrap and then every 24 hours', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const job = new ActivityPruneJob(serviceWith(prune));
    await job.onApplicationBootstrap();
    expect(prune).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    job.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('logs and keeps going when a prune fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    const prune = jest.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(1);
    const job = new ActivityPruneJob(serviceWith(prune));
    await expect(job.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('locked'));
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    job.onModuleDestroy();
    warn.mockRestore();
  });
});
