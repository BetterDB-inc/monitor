import { NotFoundException } from '@nestjs/common';
import { CacheSimulatorService, FAILURE_TTL_MS, RESULT_TTL_MS } from '../cache-simulator.service';
import * as sampler from '../stratified-sampler';

const info = (usedMemory: number, maxmemory: number) => ({ memory: { used_memory: String(usedMemory), maxmemory: String(maxmemory), maxmemory_policy: 'allkeys-lru' }, stats: {} });

function client(usedMemory = 1000, maxmemory = 10_000, dbSize = 5) {
  return { getInfoParsed: jest.fn().mockResolvedValue(info(usedMemory, maxmemory)), getDbSize: jest.fn().mockResolvedValue(dbSize), getRole: jest.fn().mockResolvedValue({ role: 'master' }) };
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
  return { service: new CacheSimulatorService(registry as any, storage as any), registry, connections };
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

  it('falls back to the seed when no primary is reachable', async () => {
    const spy = jest.spyOn(sampler, 'sampleNodes').mockReturnValue(new Promise(() => undefined));
    const connections = { seed: client(1000, 10_000, 5), m1: client(2000, 10_000, 7) };
    connections.seed.getRole.mockRejectedValue(new Error('down'));
    connections.m1.getRole.mockResolvedValue({ role: 'slave' });
    const statuses = [
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name: 'm1', isConnected: true, connectionType: 'direct', membership: { seedId: 'seed', source: 'cluster' } },
    ];
    const { service } = setup(connections, statuses);
    const result = await service.snapshot('seed');
    expect(spy.mock.calls[0][0].map((node) => node.name)).toEqual(['seed']);
    expect(result.instant.totalKeys).toBe(5);
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
    expect(connections.c1.getInfoParsed).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(FAILURE_TTL_MS + 1);
    connections.c1.getInfoParsed.mockResolvedValue(info(1000, 10_000));
    expect((await service.snapshot('c1')).status).toBe('sampling');
    expect(connections.c1.getInfoParsed).toHaveBeenCalledTimes(2);
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
});
