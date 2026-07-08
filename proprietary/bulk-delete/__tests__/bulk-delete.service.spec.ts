/* eslint-disable @typescript-eslint/no-explicit-any */
import { BulkDeleteService } from '../bulk-delete.service';
import { BulkDeleteValidationError } from '../bulk-delete-engine';
import { StoredBulkDeleteAudit } from '@app/common/interfaces/storage-port.interface';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Minimal fake iovalkey client: SCAN returns the current matching set in a
 * single page (cursor '0'); UNLINK is issued as a pipeline of per-key deletes
 * (the cluster-safe path).
 */
function makeFakeClient(initialKeys: string[]) {
  const set = new Set(initialKeys);
  const call = jest.fn(async (command: string, ...args: any[]) => {
    if (command === 'SCAN') {
      const pattern = String(args[2]);
      const re = globToRegExp(pattern);
      const matched = [...set].filter((k) => re.test(k));
      return ['0', matched];
    }
    throw new Error(`unexpected command ${command}`);
  });
  const pipeline = () => {
    const ops: string[] = [];
    const chain: any = {
      unlink(key: string) {
        ops.push(key);
        return chain;
      },
      async exec() {
        return ops.map((k) => [null, set.delete(k) ? 1 : 0]);
      },
    };
    return chain;
  };
  return { client: { call, pipeline } as any, set, call };
}

async function waitForJob(
  service: BulkDeleteService,
  jobId: string,
  connectionId: string,
  timeoutMs = 1000,
) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = service.getJob(jobId, connectionId);
    if (job && job.status !== 'running') return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not finish`);
    await new Promise((r) => setImmediate(r));
  }
}

describe('BulkDeleteService', () => {
  let storage: {
    saveBulkDeleteAudit: jest.Mock;
    getBulkDeleteAudits: jest.Mock;
    markInterruptedBulkDeleteRuns: jest.Mock;
  };
  let cluster: { discoverNodes: jest.Mock; getNodeConnection: jest.Mock };

  const makeRegistry = (client: any) => ({
    get: jest.fn(() => ({ getClient: () => client })),
    getConfig: jest.fn(() => ({ host: 'h', port: 6379 })),
  });

  beforeEach(() => {
    storage = {
      saveBulkDeleteAudit: jest.fn(async (r: StoredBulkDeleteAudit) => r.id),
      getBulkDeleteAudits: jest.fn(async () => []),
      markInterruptedBulkDeleteRuns: jest.fn(async () => 0),
    };
    cluster = { discoverNodes: jest.fn(), getNodeConnection: jest.fn() };
  });

  const build = (client: any) =>
    new BulkDeleteService(makeRegistry(client) as any, cluster as any, storage as any);

  it('preview runs as a dry-run job and reports matches without deleting', async () => {
    const { client, set, call } = makeFakeClient(['a:1', 'a:2', 'b:1']);
    const service = build(client);

    const { jobId } = service.startPreview('conn-1', { match: 'a:*' });
    const job = await waitForJob(service, jobId, 'conn-1');

    expect(job.mode).toBe('dry-run');
    expect(job.matched).toBe(2);
    expect(job.deleted).toBe(0);
    expect(job.sampleKeys.sort()).toEqual(['a:1', 'a:2']);
    expect(set.size).toBe(3);
    // Dry-runs are not audited.
    expect(storage.saveBulkDeleteAudit).not.toHaveBeenCalled();
    // SCAN happened via the direct call path.
    expect(call.mock.calls[0][0]).toBe('SCAN');
  });

  it('execute deletes matching keys and persists an audit record', async () => {
    const { client, set } = makeFakeClient(['sess:1', 'sess:2', 'keep:1']);
    const service = build(client);

    const { jobId, status } = service.startExecution('conn-1', { match: 'sess:*' });
    expect(status).toBe('running');

    const job = await waitForJob(service, jobId, 'conn-1');
    expect(job.status).toBe('completed');
    expect(job.matched).toBe(2);
    expect(job.deleted).toBe(2);
    expect(set.has('keep:1')).toBe(true);
    expect(set.has('sess:1')).toBe(false);

    const finalAudit = storage.saveBulkDeleteAudit.mock.calls.at(-1)![0] as StoredBulkDeleteAudit;
    expect(finalAudit).toMatchObject({
      id: jobId,
      connectionId: 'conn-1',
      status: 'completed',
      match: 'sess:*',
      scope: 'node',
      deleted: 2,
      skippedNodes: [],
      sourceHost: 'h',
      sourcePort: 6379,
    });
  });

  it('rejects an invalid request synchronously (no job created)', () => {
    const { client } = makeFakeClient([]);
    const service = build(client);

    expect(() => service.startExecution('conn-1', { match: '' })).toThrow(BulkDeleteValidationError);
    expect(() => service.startPreview('conn-1', { match: '*' })).toThrow(BulkDeleteValidationError);
  });

  it('scopes job access to the owning connection', async () => {
    const { client } = makeFakeClient(['a:1']);
    const service = build(client);

    const { jobId } = service.startExecution('conn-1', { match: 'a:*' });
    // A different connection cannot see or cancel the job.
    expect(service.getJob(jobId, 'other')).toBeNull();
    expect(service.cancelJob(jobId, 'other')).toBeNull();
    await waitForJob(service, jobId, 'conn-1');
  });

  it('fans out across cluster primaries when scope is cluster', async () => {
    const nodeA = makeFakeClient(['t:1', 't:2', 'x:1']);
    const nodeB = makeFakeClient(['t:3', 'y:1']);
    const service = build(makeFakeClient([]).client);

    cluster.discoverNodes.mockResolvedValue([
      { id: 'a', address: '10.0.0.1:6379@16379', role: 'master' },
      { id: 'b', address: '10.0.0.2:6379@16379', role: 'master' },
      { id: 'c', address: '10.0.0.3:6379@16379', role: 'replica' },
    ]);
    cluster.getNodeConnection.mockImplementation(async (id: string) =>
      id === 'a' ? nodeA.client : nodeB.client,
    );

    const { jobId } = service.startExecution('conn-1', { match: 't:*', scope: 'cluster' });
    const job = await waitForJob(service, jobId, 'conn-1');

    expect(cluster.getNodeConnection).toHaveBeenCalledTimes(2); // only the two primaries
    expect(job.status).toBe('completed');
    expect(job.deleted).toBe(3); // t:1, t:2 on A + t:3 on B
    expect(job.nodesTotal).toBe(2);
    expect(job.perNode.map((n) => n.node)).toEqual(['10.0.0.1:6379', '10.0.0.2:6379']);
    expect(nodeA.set.has('x:1')).toBe(true);
    expect(nodeB.set.has('y:1')).toBe(true);

    const finalAudit = storage.saveBulkDeleteAudit.mock.calls.at(-1)![0] as StoredBulkDeleteAudit;
    expect(finalAudit).toMatchObject({ scope: 'cluster', nodes: 2, deleted: 3 });
  });

  it('skips an unreachable primary and records it instead of failing the run', async () => {
    const nodeA = makeFakeClient(['t:1', 't:2']);
    const service = build(makeFakeClient([]).client);

    cluster.discoverNodes.mockResolvedValue([
      { id: 'a', address: '10.0.0.1:6379@16379', role: 'master' },
      { id: 'b', address: '10.0.0.2:6379@16379', role: 'master' },
    ]);
    cluster.getNodeConnection.mockImplementation(async (id: string) => {
      if (id === 'a') return nodeA.client;
      throw new Error('Connection timeout');
    });

    const { jobId } = service.startExecution('conn-1', { match: 't:*', scope: 'cluster' });
    const job = await waitForJob(service, jobId, 'conn-1');

    expect(job.status).toBe('completed'); // did NOT fail the whole run
    expect(job.deleted).toBe(2); // only node A's keys
    expect(job.skipped).toEqual([{ node: '10.0.0.2:6379', error: 'Connection timeout' }]);

    const finalAudit = storage.saveBulkDeleteAudit.mock.calls.at(-1)![0] as StoredBulkDeleteAudit;
    expect(finalAudit.skippedNodes).toEqual(['10.0.0.2:6379']);
  });

  it('cancelJob returns null for unknown ids and false for finished jobs', async () => {
    const { client } = makeFakeClient(['a:1']);
    const service = build(client);

    expect(service.cancelJob('does-not-exist', 'conn-1')).toBeNull();

    const { jobId } = service.startExecution('conn-1', { match: 'a:*' });
    await waitForJob(service, jobId, 'conn-1');
    expect(service.cancelJob(jobId, 'conn-1')).toBe(false);
  });

  it('reconciles interrupted runs on startup', async () => {
    const { client } = makeFakeClient([]);
    const service = build(client);

    await service.onModuleInit();

    expect(storage.markInterruptedBulkDeleteRuns).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
    );
  });
});
