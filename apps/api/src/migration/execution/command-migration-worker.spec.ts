import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExecutionJob } from './execution-job';
import { generateTlsPair } from '../../../test/helpers/tls-fixtures';

type MockClient = {
  host: string;
  port: number;
  options: { connectionName?: string; tls?: { servername?: string; cert?: Buffer | string } };
  handlers: Record<string, () => void>;
  on: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
  quit: jest.Mock;
  call: jest.Mock;
  dbsize: jest.Mock;
};

const clients: MockClient[] = [];
let clusterNodesRaw = '';
let failingHosts = new Set<string>();

jest.mock('iovalkey', () => {
  const ctor = jest.fn().mockImplementation((opts: { host: string; port: number; connectionName?: string; tls?: { servername?: string } }) => {
    const handlers: Record<string, () => void> = {};
    const client: MockClient = {
      host: opts.host,
      port: opts.port,
      options: opts,
      handlers,
      on: jest.fn().mockImplementation((event: string, handler: () => void) => {
        handlers[event] = handler;
      }),
      connect: jest.fn().mockImplementation(() =>
        failingHosts.has(opts.host) ? Promise.reject(new Error('Connection is closed.')) : Promise.resolve(),
      ),
      disconnect: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      call: jest.fn().mockImplementation(async (...args: string[]) => (args[0] === 'CLUSTER' ? clusterNodesRaw : null)),
      dbsize: jest.fn().mockResolvedValue(0),
    };
    clients.push(client);
    return client;
  });
  const Cluster = jest.fn().mockImplementation(() => ({ on: jest.fn(), connect: jest.fn().mockResolvedValue(undefined), quit: jest.fn().mockResolvedValue('OK') }));
  return { __esModule: true, default: ctor, Cluster };
});

import { parseClusterMasters, runCommandMigration } from './command-migration-worker';

const CERT = '-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----';

function makeJob(): ExecutionJob {
  return {
    id: 'job-1',
    mode: 'command',
    status: 'pending',
    startedAt: Date.now(),
    keysTransferred: 0,
    bytesTransferred: 0,
    keysSkipped: 0,
    totalKeys: 0,
    logs: [],
    notices: [],
    progress: 0,
    syncStage: null,
    replicationLag: null,
    expectedShards: null,
    statusPort: null,
    statusPoller: null,
    cutover: null,
    cutoverTimer: null,
    cutoverStableSince: null,
    cutoverKilled: false,
    terminating: null,
    process: null,
    tomlPath: null,
    pidPath: null,
  } as unknown as ExecutionJob;
}

const sourceConfig = {
  id: 'src',
  name: 'Source',
  host: 'cache.internal',
  port: 6379,
  tls: true,
  tlsConfig: { source: 'inline' as const, cert: CERT, key: KEY },
  createdAt: 1,
};
const targetConfig = { id: 'dst', name: 'Target', host: 'target.internal', port: 6380, createdAt: 1 };

describe('parseClusterMasters', () => {
  it('splits the announced hostname off the address field', () => {
    const raw = [
      'a 10.0.0.1:6379@16379,node-a.internal master - 0 0 1 connected 0-8191',
      'b 10.0.0.2:6379@16379, master - 0 0 2 connected 8192-16383',
      'c 10.0.0.3:6379@16379 slave a 0 0 1 connected',
      'd [::1]:6379@16379,node-d.internal master - 0 0 3 connected',
      'e 10.0.0.5:6379@16379 master,fail - 0 0 4 connected',
    ].join('\n');
    expect(parseClusterMasters(raw)).toEqual([
      { host: '10.0.0.1', port: 6379, hostname: 'node-a.internal' },
      { host: '10.0.0.2', port: 6379 },
      { host: '::1', port: 6379, hostname: 'node-d.internal' },
    ]);
  });
});

describe('runCommandMigration source clients', () => {
  beforeEach(() => {
    clients.length = 0;
    failingHosts = new Set();
    clusterNodesRaw = [
      'a 10.0.0.1:6379@16379,node-a.internal master - 0 0 1 connected 0-8191',
      'b 10.0.0.2:6379@16379 master - 0 0 2 connected 8192-16383',
    ].join('\n');
  });

  it('tears down a source client whose connect fails instead of leaving it reconnecting', async () => {
    failingHosts = new Set(['10.0.0.2']);

    await expect(
      runCommandMigration({ sourceConfig, targetConfig, sourceIsCluster: true, targetIsCluster: false, job: makeJob(), maxLogLines: 50 }),
    ).rejects.toThrow('Connection is closed.');

    const failed = clients.find((c) => c.host === '10.0.0.2');
    expect(failed?.disconnect).toHaveBeenCalled();
    expect(failed?.quit).toHaveBeenCalled();
    // Every client the worker opened is quit by the outer cleanup, failed one included.
    expect(clients.filter((c) => c.host !== 'cache.internal').every((c) => c.quit.mock.calls.length > 0)).toBe(true);
  });

  it('tears down a standalone source client whose connect fails instead of leaving it reconnecting', async () => {
    failingHosts = new Set(['cache.internal']);

    await expect(
      runCommandMigration({ sourceConfig, targetConfig, sourceIsCluster: false, targetIsCluster: false, job: makeJob(), maxLogLines: 50 }),
    ).rejects.toThrow('Connection is closed.');

    const standalone = clients.find((c) => c.host === 'cache.internal' && c.options.connectionName === 'BetterDB-Migration-Source');
    expect(standalone).toBeDefined();
    expect(standalone!.disconnect).toHaveBeenCalled();
    expect(standalone!.quit).toHaveBeenCalled();
  });

  it('re-reads file-sourced certificates before any source client reconnects (cluster masters and standalone)', async () => {
    const pairA = generateTlsPair('a');
    const pairB = generateTlsPair('b');
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-rotation-'));
    try {
      const certPath = path.join(certDir, 'client.crt');
      const keyPath = path.join(certDir, 'client.key');
      fs.writeFileSync(certPath, pairA.cert);
      fs.writeFileSync(keyPath, pairA.key);
      const fileSource = { ...sourceConfig, tlsConfig: { source: 'file' as const, trustedPaths: true, certPath, keyPath } };
      const job = makeJob();
      failingHosts = new Set(['10.0.0.2']); // stop before the SCAN phase
      await runCommandMigration({ sourceConfig: fileSource, targetConfig, sourceIsCluster: true, targetIsCluster: false, job, maxLogLines: 50 }).catch(() => undefined);

      const nodeA = clients.find((c) => c.host === '10.0.0.1')!;
      expect(nodeA.options.tls?.cert?.toString()).toBe(pairA.cert);

      // Mid-rotation (certificate replaced, key not yet): the mismatched pair is not adopted.
      fs.writeFileSync(certPath, pairB.cert);
      nodeA.handlers['reconnecting']();
      expect(nodeA.options.tls?.cert?.toString()).toBe(pairA.cert);
      expect(job.logs.some((l) => /Keeping previously loaded TLS files for 10.0.0.1:6379/.test(l))).toBe(true);

      fs.writeFileSync(keyPath, pairB.key);
      nodeA.handlers['reconnecting']();
      expect(nodeA.options.tls?.cert?.toString()).toBe(pairB.cert);
      expect(nodeA.options.tls?.servername).toBe('node-a.internal');

      // An unreadable rotation keeps the loaded material instead of breaking the client.
      fs.rmSync(certPath);
      nodeA.handlers['reconnecting']();
      expect(nodeA.options.tls?.cert?.toString()).toBe(pairB.cert);

      // The standalone branch gets the same handler through createClient.
      clients.length = 0;
      fs.writeFileSync(certPath, pairA.cert);
      fs.writeFileSync(keyPath, pairA.key);
      await runCommandMigration({ sourceConfig: fileSource, targetConfig, sourceIsCluster: false, targetIsCluster: false, job: makeJob(), maxLogLines: 50 }).catch(() => undefined);
      const standalone = clients.find((c) => c.host === 'cache.internal')!;
      expect(standalone.handlers['reconnecting']).toBeDefined();
      fs.writeFileSync(certPath, pairB.cert);
      fs.writeFileSync(keyPath, pairB.key);
      standalone.handlers['reconnecting']();
      expect(standalone.options.tls?.cert?.toString()).toBe(pairB.cert);
      expect(standalone.options.tls?.servername).toBe('cache.internal');
    } finally {
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  it('does not install a reconnect refresh for inline material', async () => {
    failingHosts = new Set(['10.0.0.2']);
    await runCommandMigration({ sourceConfig, targetConfig, sourceIsCluster: true, targetIsCluster: false, job: makeJob(), maxLogLines: 50 }).catch(() => undefined);
    const nodeA = clients.find((c) => c.host === '10.0.0.1')!;
    expect(nodeA.handlers['reconnecting']).toBeUndefined();
  });

  it('verifies a master dialled by IP against the hostname it announces', async () => {
    failingHosts = new Set(['10.0.0.2']); // stop before the SCAN phase
    await runCommandMigration({ sourceConfig, targetConfig, sourceIsCluster: true, targetIsCluster: false, job: makeJob(), maxLogLines: 50 }).catch(() => undefined);

    const nodeA = clients.find((c) => c.host === '10.0.0.1');
    expect(nodeA?.options.tls?.servername).toBe('node-a.internal');
    expect(nodeA?.options.tls).toMatchObject({ cert: CERT, key: KEY });
    const nodeB = clients.find((c) => c.host === '10.0.0.2');
    expect(nodeB?.options.tls?.servername).toBeUndefined();
  });
});
