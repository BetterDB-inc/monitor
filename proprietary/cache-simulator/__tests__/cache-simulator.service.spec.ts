import { NotFoundException } from '@nestjs/common';
import { CacheSimulatorService, FAILURE_TTL_MS, RESULT_TTL_MS, SETUP_TIMEOUT_MS } from '../cache-simulator.service';
import * as sampler from '../stratified-sampler';

const info = (usedMemory: number, maxmemory: number, policy = 'allkeys-lru', dataset?: number) => ({
  memory: { used_memory: String(usedMemory), maxmemory: String(maxmemory), maxmemory_policy: policy, ...(dataset === undefined ? {} : { used_memory_dataset: String(dataset) }) },
});

function client(usedMemory = 1000, maxmemory = 10_000, dbSize = 5) {
  return { getInfoParsed: jest.fn().mockResolvedValue(info(usedMemory, maxmemory)), getDbSize: jest.fn().mockResolvedValue(dbSize), getRole: jest.fn().mockResolvedValue({ role: 'master' }), getClusterInfo: jest.fn().mockResolvedValue({ cluster_size: '2' }) };
}

function setup(connections: Record<string, ReturnType<typeof client>> = { c1: client() }, statuses: any[] = []) {
  const registry = {
    get: jest.fn((id: string) => {
      if (!connections[id]) throw new NotFoundException(id);
      return connections[id];
    }),
    getConfig: jest.fn((id: string) => (connections[id] ? { id, name: id } : null)),
    list: jest.fn(() => (statuses.length ? statuses : Object.keys(connections).map((id) => ({ id, name: id, isConnected: true })))),
  };
  const storage = { getMemorySnapshots: jest.fn().mockResolvedValue([]) };
  return { service: new CacheSimulatorService(registry as any, storage as any), registry, connections, storage };
}

const nodeSample = { node: 'c1', dbSize: 5, strata: [{ type: 'string', estimatedKeys: 5, exact: true, observed: 0, sizes: [10, 10, 10, 10, 10] }], exhausted: true, timedOut: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('CacheSimulatorService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns the INFO estimate while sampling, then the sampled result', async () => {
    const job = deferred<typeof nodeSample[]>();
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(job.promise);
    const { service } = setup();
    const first = await service.snapshot('c1');
    expect(first).toMatchObject({ status: 'sampling', estimate: null, instant: { usedMemory: 1000, maxmemory: 10_000, maxmemoryPolicy: 'allkeys-lru', totalKeys: 5 } });
    expect(first.progress).toEqual({ sampled: 0, target: sampler.SAMPLE_BUDGET });
    job.resolve([nodeSample]);
    await flush();
    const second = await service.snapshot('c1');
    expect(second.status).toBe('ready');
    expect(second.estimate?.totalBytes).toBe(50);
    expect(second.progress).toBeNull();
  });

  it('passes the hard cap to the sampler', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const { service } = setup();
    await service.snapshot('c1');
    expect(spy.mock.calls[0][1]).toMatchObject({ budget: sampler.SAMPLE_BUDGET, hardCap: sampler.SAMPLE_HARD_CAP, deadlineMs: sampler.SAMPLE_DEADLINE_MS });
  });

  it('runs one job per connection', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const { service } = setup();
    await service.snapshot('c1');
    await service.snapshot('c1');
    await service.snapshot('c1', true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves the cached result for 15 minutes, then samples again', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const spy = jest.spyOn(sampler, 'sampleNodes').mockResolvedValue([nodeSample]);
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    jest.advanceTimersByTime(RESULT_TTL_MS - 1);
    expect((await service.snapshot('c1')).status).toBe('ready');
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2);
    expect((await service.snapshot('c1')).status).toBe('sampling');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('restarts on refresh when no job is running', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockResolvedValue([nodeSample]);
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    expect((await service.snapshot('c1', true)).status).toBe('sampling');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('caches unsupported-command failures for one minute', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const spy = jest.spyOn(sampler, 'sampleNodes').mockRejectedValue(new sampler.SamplerUnsupportedError("ERR unknown command 'MEMORY'"));
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    const failed = await service.snapshot('c1');
    expect(failed).toMatchObject({ status: 'failed', error: "ERR unknown command 'MEMORY'", estimate: null });
    expect(failed.instant.usedMemory).toBe(1000);
    jest.advanceTimersByTime(FAILURE_TTL_MS + 1);
    await service.snapshot('c1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reports progress from the running job', async () => {
    let report!: (sampled: number) => void;
    jest.spyOn(sampler, 'sampleNodes').mockImplementation((_nodes, options) => {
      report = options.onProgress!;
      return new Promise(() => undefined);
    });
    const { service } = setup();
    await service.snapshot('c1');
    report(1200);
    expect((await service.snapshot('c1')).progress).toEqual({ sampled: 1200, target: sampler.SAMPLE_BUDGET });
  });

  it('drops a job whose connection was removed', async () => {
    const job = deferred<typeof nodeSample[]>();
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(job.promise);
    const { service, connections } = setup();
    await service.snapshot('c1');
    delete connections.c1;
    job.resolve([nodeSample]);
    await flush();
    await expect(service.snapshot('c1')).rejects.toBeInstanceOf(NotFoundException);
    connections.c1 = client();
    expect((await service.snapshot('c1')).status).toBe('sampling');
  });

  it('sums instant figures across cluster primaries', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    const result = await service.snapshot('seed');
    expect(result.instant).toMatchObject({ usedMemory: 3000, maxmemory: 20_000, totalKeys: 12 });
    expect(spy.mock.calls[0][0].map((node) => node.name)).toEqual(['seed', 'm1']);
  });

  it('reports no cluster limit when a primary is unlimited and mixed policies as mixed', async () => {
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 0, 7) };
    connections.m1.getInfoParsed.mockResolvedValue(info(2000, 0, 'noeviction'));
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    const result = await service.snapshot('seed');
    expect(result.instant).toMatchObject({ maxmemory: 0, maxmemoryPolicy: 'mixed' });
  });

  it('fails setup when no primary is reachable', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getRole.mockRejectedValue(new Error('down'));
    connections.m1.getRole.mockResolvedValue({ role: 'slave' });
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    expect(await service.snapshot('seed')).toMatchObject({ status: 'failed', error: 'Only 0 of 2 cluster primaries are reachable, so the totals would be understated' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails setup when the cluster size cannot be read', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getClusterInfo.mockRejectedValue(new Error('NOPERM'));
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    expect(await service.snapshot('seed')).toMatchObject({ status: 'failed', error: 'Could not read the cluster size from seed: NOPERM' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails setup when the cluster reports no size', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getClusterInfo.mockResolvedValue({});
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    expect(await service.snapshot('seed')).toMatchObject({ status: 'failed', error: 'seed reported no cluster size, so the totals cannot be checked' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails setup when fewer primaries are reachable than the cluster reports', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections: any = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getClusterInfo = jest.fn().mockResolvedValue({ cluster_size: '3' });
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
      { id: 'm2', name: 'm2', isConnected: false, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    const result = await service.snapshot('seed');
    expect(result).toMatchObject({ status: 'failed', error: 'Only 2 of 3 cluster primaries are reachable, so the totals would be understated' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('samples when every primary the cluster reports is reachable', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections: any = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getClusterInfo = jest.fn().mockResolvedValue({ cluster_size: '2' });
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    expect(await service.snapshot('seed')).toMatchObject({ status: 'sampling' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sums growth across cluster primaries and needs history for each', async () => {
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const day = 86_400_000;
    const history = (keysPerDay: number, bytesPerDay: number, days: number) =>
      Array.from({ length: days * 4 + 1 }, (_, index) => ({ timestamp: Date.now() - (days - index / 4) * day, usedMemory: 1_000_000 + (bytesPerDay * index) / 4, totalKeys: 1000 + (keysPerDay * index) / 4 }));
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const connections = { seed: client(), m1: client() };
    const { service, storage } = setup(connections, statuses);
    storage.getMemorySnapshots.mockImplementation(async ({ connectionId }: { connectionId: string }) =>
      connectionId === 'seed' ? history(50, 4000, 10) : history(30, 1000, 6),
    );
    const result = await service.snapshot('seed');
    expect(result.growth!.keysPerDay).toBeCloseTo(80, 3);
    expect(result.growth!.bytesPerDay).toBeCloseTo(5000, 3);
    expect(result.growth!.days).toBeCloseTo(6, 3);
    expect(storage.getMemorySnapshots.mock.calls.map(([query]: any[]) => query.connectionId).sort()).toEqual(['m1', 'seed']);

    const second = setup({ seed: client(), m1: client() }, statuses);
    second.storage.getMemorySnapshots.mockImplementation(async ({ connectionId }: { connectionId: string }) =>
      connectionId === 'seed' ? history(50, 4000, 10) : [],
    );
    expect((await second.service.snapshot('seed')).growth).toBeNull();
  });

  it('joins a refresh in progress instead of serving the cached result', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockResolvedValue([nodeSample]);
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    expect((await service.snapshot('c1')).status).toBe('ready');
    const [refreshed, polled] = await Promise.all([service.snapshot('c1', true), service.snapshot('c1')]);
    expect(refreshed.status).toBe('sampling');
    expect(polled.status).toBe('sampling');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('starts one job for concurrent first calls', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const { service } = setup();
    const [a, b] = await Promise.all([service.snapshot('c1'), service.snapshot('c1')]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('sampling');
    expect(b.status).toBe('sampling');
  });

  it('caches a setup failure for one minute, then retries', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { c1: client() };
    connections.c1.getInfoParsed.mockRejectedValue(new Error('INFO down'));
    const { service } = setup(connections);
    const failed = await service.snapshot('c1');
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'INFO down',
      estimate: null,
      growth: null,
      instant: { usedMemory: 0, maxmemory: 0, maxmemoryPolicy: 'unknown', totalKeys: 0 },
    });
    await service.snapshot('c1');
    expect(connections.c1.getInfoParsed).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(FAILURE_TTL_MS + 1);
    connections.c1.getInfoParsed.mockResolvedValue(info(1000, 10_000));
    expect((await service.snapshot('c1')).status).toBe('sampling');
    expect(connections.c1.getInfoParsed).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns running progress on refresh without starting another job', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const { service } = setup();
    await service.snapshot('c1');
    const refreshed = await service.snapshot('c1', true);
    expect(refreshed.status).toBe('sampling');
    expect(refreshed.progress).toEqual({ sampled: 0, target: sampler.SAMPLE_BUDGET });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a node read once before failing', async () => {
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { c1: client() };
    connections.c1.getInfoParsed.mockRejectedValueOnce(new Error('blip'));
    const { service } = setup(connections);
    expect((await service.snapshot('c1')).status).toBe('sampling');
  });

  it('keeps the last good result when a refresh fails in setup', async () => {
    jest.spyOn(sampler, 'sampleNodes').mockResolvedValue([nodeSample]);
    const connections = { c1: client() };
    const { service } = setup(connections);
    await service.snapshot('c1');
    await flush();
    const good = await service.snapshot('c1');
    connections.c1.getInfoParsed.mockRejectedValue(new Error('INFO down'));
    const refreshed = await service.snapshot('c1', true);
    expect(refreshed).toMatchObject({ status: 'ready', estimate: good.estimate, instant: good.instant, error: 'INFO down' });
    expect(await service.snapshot('c1')).toEqual(refreshed);
  });

  it('keeps the last good result when a refresh fails while sampling', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockResolvedValueOnce([nodeSample]).mockRejectedValueOnce(new Error('node gone'));
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    await service.snapshot('c1', true);
    await flush();
    expect(await service.snapshot('c1')).toMatchObject({ status: 'ready', error: 'node gone', estimate: { totalBytes: 50 } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('backs off after a failed resample of an expired result', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const spy = jest.spyOn(sampler, 'sampleNodes').mockResolvedValueOnce([nodeSample]).mockRejectedValue(new Error('node gone'));
    const { service } = setup();
    await service.snapshot('c1');
    await flush();
    jest.advanceTimersByTime(RESULT_TTL_MS + 1);
    await service.snapshot('c1');
    await flush();
    expect(await service.snapshot('c1')).toMatchObject({ status: 'ready', error: 'node gone' });
    expect(spy).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(FAILURE_TTL_MS + 1);
    await service.snapshot('c1');
    await flush();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('times out a hung setup instead of wedging the connection', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { c1: client() };
    connections.c1.getInfoParsed.mockReturnValue(new Promise(() => undefined));
    const { service } = setup(connections);
    const pending = service.snapshot('c1');
    jest.advanceTimersByTime(SETUP_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ status: 'failed', error: `Setup timed out after ${SETUP_TIMEOUT_MS / 1000} s` });
    jest.advanceTimersByTime(FAILURE_TTL_MS + 1);
    connections.c1.getInfoParsed.mockResolvedValue(info(1000, 10_000));
    expect((await service.snapshot('c1')).status).toBe('sampling');
  });

  it('bounds the interval by the dataset memory when keys go unsampled', async () => {
    const partial = { ...nodeSample, strata: [{ ...nodeSample.strata[0], estimatedKeys: 10 }], exhausted: false };
    jest.spyOn(sampler, 'sampleNodes').mockResolvedValue([partial]);
    const connections = { c1: client() };
    connections.c1.getInfoParsed.mockResolvedValue(info(5000, 10_000, 'allkeys-lru', 1000));
    const { service } = setup(connections);
    await service.snapshot('c1');
    await flush();
    const result = await service.snapshot('c1');
    expect(result.estimate).toMatchObject({ totalBytes: 100, ci95Bytes: 1000 + 5 * 24 - 100 });
  });

  it('logs and drops growth when history cannot be read', async () => {
    jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const { service, storage } = setup();
    storage.getMemorySnapshots.mockRejectedValue(new Error('storage down'));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    expect((await service.snapshot('c1')).growth).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('storage down'));
  });
});
