import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { WorkspaceMode } from '@betterdb/shared';
import {
  resolveWorkspaceConfig,
  WORKSPACE_CONFIG,
  type WorkspaceConfig,
} from '../auth/workspace-config';
import { ActivityPruneJob, PRUNE_INTERVAL_MS } from './activity-prune.job';
import { ActivityService } from './activity.service';

function serviceWith(prune: jest.Mock): ActivityService {
  return { prune } as unknown as ActivityService;
}

function configWith(mode: WorkspaceMode): WorkspaceConfig {
  return { ...resolveWorkspaceConfig({}), mode, enabled: mode === 'self-hosted' };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ActivityPruneJob', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('prunes once at bootstrap without blocking it, then every 24 hours', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const job = new ActivityPruneJob(serviceWith(prune));
    job.onApplicationBootstrap();
    await flushMicrotasks();
    expect(prune).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    job.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('never prunes when the workspace is disabled', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const job = new ActivityPruneJob(serviceWith(prune), configWith('disabled'));
    job.onApplicationBootstrap();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    job.onModuleDestroy();
  });

  it('prunes in cloud mode', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const job = new ActivityPruneJob(serviceWith(prune), configWith('cloud'));
    job.onApplicationBootstrap();
    await flushMicrotasks();
    expect(prune).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    job.onModuleDestroy();
  });

  it('prunes when no workspace config is provided', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const job = new ActivityPruneJob(serviceWith(prune), null);
    job.onApplicationBootstrap();
    await flushMicrotasks();
    expect(prune).toHaveBeenCalledTimes(1);
    job.onModuleDestroy();
  });

  it('resolves the workspace config from the container and skips when disabled', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ActivityPruneJob,
        { provide: ActivityService, useValue: serviceWith(prune) },
        { provide: WORKSPACE_CONFIG, useValue: configWith('disabled') },
      ],
    }).compile();
    moduleRef.get(ActivityPruneJob).onApplicationBootstrap();
    await flushMicrotasks();
    expect(prune).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('resolves without a workspace config in the container and prunes', async () => {
    const prune = jest.fn().mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [ActivityPruneJob, { provide: ActivityService, useValue: serviceWith(prune) }],
    }).compile();
    const job = moduleRef.get(ActivityPruneJob);
    job.onApplicationBootstrap();
    await flushMicrotasks();
    expect(prune).toHaveBeenCalledTimes(1);
    job.onModuleDestroy();
    await moduleRef.close();
  });

  it('logs and keeps going when a prune fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    const prune = jest.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(1);
    const job = new ActivityPruneJob(serviceWith(prune));
    job.onApplicationBootstrap();
    await flushMicrotasks();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('locked'));
    await jest.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    job.onModuleDestroy();
    warn.mockRestore();
  });
});
