import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import {
  GRAPH_MEMORY_PROBES_PER_SCAN,
  GRAPH_MEMORY_TTL_MS,
  QUIT_TIMEOUT_MS,
  TLS_MATERIAL_RECHECK_MS,
  WHOAMI_TIMEOUT_MS,
  UnifiedDatabaseAdapter,
} from './unified.adapter';
import * as tlsMaterial from './tls-material';
import { generateTlsPair, type TlsPair } from '../../../test/helpers/tls-fixtures';

// getInfo is exercised in isolation with a mocked client. Object.create bypasses
// the real constructor (which would open a live Valkey connection).
function makeAdapter(infoImpl: (section?: string) => string) {
  const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
  const info = jest.fn((section?: string) => Promise.resolve(infoImpl(section)));
  // `client` is a getter over `_client`; set the backing field.
  (adapter as unknown as { _client: { info: typeof info } })._client = { info };
  return { adapter, info };
}

describe('UnifiedDatabaseAdapter.getInfo — Redis 6 / KeyDB compatibility', () => {
  it('fetches each section with its own single-section INFO (never multi-arg)', async () => {
    const { adapter, info } = makeAdapter((s) => `# ${s}\r\n${s}_field:1\r\n`);

    await adapter.getInfo(['keyspace', 'memory', 'cluster']);

    // One call per section — NOT one multi-section call.
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenNthCalledWith(1, 'keyspace');
    expect(info).toHaveBeenNthCalledWith(2, 'memory');
    expect(info).toHaveBeenNthCalledWith(3, 'cluster');
    // Multi-arg INFO is the Redis-7-only syntax KeyDB/Redis<7 reject with
    // "ERR syntax error" — assert we never emit it.
    for (const call of info.mock.calls) {
      expect(call.length).toBeLessThanOrEqual(1);
    }
  });

  it('merges the requested sections into one parsed result', async () => {
    const { adapter } = makeAdapter((s) => `# ${s}\r\n${s}_ok:1\r\n`);

    const result = await adapter.getInfo(['keyspace', 'memory']);

    expect(result).toHaveProperty('keyspace');
    expect(result).toHaveProperty('memory');
  });

  it('uses a single-section INFO for exactly one section (unchanged behavior)', async () => {
    const { adapter, info } = makeAdapter((s) => `# ${s}\r\n`);

    await adapter.getInfo(['memory']);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('memory');
  });

  it('uses full INFO (no args) when no sections are requested (unchanged behavior)', async () => {
    const { adapter, info } = makeAdapter(() => `# Server\r\nredis_version:7.0.0\r\n`);

    await adapter.getInfo();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith();
  });
});

describe('UnifiedDatabaseAdapter.getCapabilities — sentinel detection', () => {
  function makeSentinelAdapter(serverMode: string) {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const info = jest.fn((section?: string) =>
      Promise.resolve(
        section === 'server'
          ? `# Server\r\nredis_version:7.0.0\r\nserver_mode:${serverMode}\r\n`
          : `# ${section}\r\n`,
      ),
    );
    const config = jest.fn(() => Promise.resolve(['maxmemory', '0']));
    const call = jest.fn(() => Promise.resolve(['idx']));
    (
      adapter as unknown as {
        _client: { info: typeof info; config: typeof config; call: typeof call };
      }
    )._client = { info, config, call };
    return { adapter, info, config, call };
  }

  it('marks a sentinel INFO as isSentinel and skips CONFIG/FT._LIST probes', async () => {
    const { adapter, config, call } = makeSentinelAdapter('sentinel');

    await (adapter as unknown as { detectCapabilities(): Promise<void> }).detectCapabilities();
    const capabilities = adapter.getCapabilities();

    expect(capabilities.isSentinel).toBe(true);
    expect(capabilities.clusterEnabled).toBe(false);
    expect(capabilities.hasConfig).toBe(false);
    expect(capabilities.hasVectorSearch).toBe(false);
    expect(capabilities.hasAclLog).toBe(true);
    expect(config).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('marks a standalone INFO as isSentinel: false', async () => {
    const { adapter } = makeSentinelAdapter('standalone');

    await (adapter as unknown as { detectCapabilities(): Promise<void> }).detectCapabilities();
    const capabilities = adapter.getCapabilities();

    expect(capabilities.isSentinel).toBe(false);
  });
});

describe('UnifiedDatabaseAdapter.disconnect', () => {
  it('closes the socket when QUIT gets no answer', async () => {
    jest.useFakeTimers();
    try {
      const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
      const client = { quit: jest.fn(() => new Promise(() => undefined)), disconnect: jest.fn() };
      (adapter as unknown as { _client: typeof client })._client = client;
      const pending = adapter.disconnect();
      await jest.advanceTimersByTimeAsync(QUIT_TIMEOUT_MS);
      await pending;
      expect(client.disconnect).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not force-close after a clean QUIT', async () => {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const client = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    (adapter as unknown as { _client: typeof client })._client = client;
    await adapter.disconnect();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

describe('UnifiedDatabaseAdapter.getInfoParsed', () => {
  it('parses raw INFO keyspace lines into typed objects (issue #360)', async () => {
    const { adapter } = makeAdapter(
      () =>
        `# Stats\r\nkeyspace_hits:42\r\n\r\n# Keyspace\r\ndb0:keys=568,expires=310,avg_ttl=7510966104\r\n`,
    );

    const result = await adapter.getInfoParsed();

    expect(result.keyspace).toEqual({
      db0: { keys: 568, expires: 310, avg_ttl: 7510966104 },
    });
    // Scalar sections stay strings.
    expect(result.stats?.keyspace_hits).toBe('42');
  });
});

type PipelineReply = [Error | null, unknown];

// A pipeline fake that answers each queued command, so key-scan tests can
// assert which commands were sent instead of relying on reply positions.
function fakeKeyPipeline(
  reply: (command: string, key: string) => PipelineReply,
  sent: string[] = [],
  types: Record<string, string> = {},
) {
  return () => {
    const queued: Array<[string, string]> = [];
    const chain = {
      memory: (_sub: string, key: string) => (queued.push(['MEMORY USAGE', key]), chain),
      object: (sub: string, key: string) => (queued.push([`OBJECT ${sub}`, key]), chain),
      ttl: (key: string) => (queued.push(['TTL', key]), chain),
      type: (key: string) => (queued.push(['TYPE', key]), chain),
      call: (command: string, key: string) => (queued.push([command, key]), chain),
      exec: async () =>
        queued.map(([command, key]) => {
          sent.push(command);
          return command === 'TYPE' ? [null, types[key] ?? 'string'] : reply(command, key);
        }),
    };
    return chain;
  };
}

describe('UnifiedDatabaseAdapter.collectKeyAnalytics — stale keys', () => {
  const DAY = 86400;

  function makeScanAdapter(idleByKey: Record<string, number>) {
    const keys = Object.keys(idleByKey);
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const pipeline = fakeKeyPipeline((command, key) => {
      if (command === 'OBJECT IDLETIME') return [null, idleByKey[key]];
      return [null, command === 'TTL' ? -1 : 100];
    });
    (adapter as unknown as { _client: unknown })._client = {
      dbsize: jest.fn().mockResolvedValue(keys.length),
      scan: jest.fn().mockResolvedValue(['0', keys]),
      info: jest.fn().mockResolvedValue(`# Keyspace\r\ndb0:keys=${keys.length},expires=0,avg_ttl=0`),
      pipeline,
    };
    (adapter as unknown as { config: unknown }).config = {};
    (adapter as unknown as { graphMemoryCache: Map<string, unknown> }).graphMemoryCache = new Map();
    return adapter;
  }

  it('counts the sampled keys idle beyond a day, even when the average idle time exceeds a day', async () => {
    const adapter = makeScanAdapter({
      'session:1': 10,
      'session:2': 20,
      'session:3': 30,
      'session:4': 10 * DAY,
      'session:5': DAY,
    });

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    const [sessions] = result.patterns;
    expect(sessions.totalIdleTime / sessions.count).toBeGreaterThan(DAY);
    expect(sessions.staleCount).toBe(1);
  });
});

describe('UnifiedDatabaseAdapter.collectKeyAnalytics — no error replies', () => {
  function makeAdapter(
    types: Record<string, string>,
    reply: (command: string, key: string) => PipelineReply,
    sent: string[],
  ) {
    const keys = Object.keys(types);
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    (adapter as unknown as { _client: unknown })._client = {
      dbsize: jest.fn().mockResolvedValue(keys.length),
      scan: jest.fn().mockResolvedValue(['0', keys]),
      info: jest.fn().mockResolvedValue(`# Keyspace\r\ndb0:keys=${keys.length},expires=0,avg_ttl=0`),
      pipeline: fakeKeyPipeline(reply, sent, types),
    };
    (adapter as unknown as { config: unknown }).config = {};
    (adapter as unknown as { graphMemoryCache: Map<string, unknown> }).graphMemoryCache = new Map();
    (adapter as unknown as { logger: unknown }).logger = { debug: jest.fn(), warn: jest.fn() };
    return adapter;
  }

  it('sends only the size command that matches each key type', async () => {
    const sent: string[] = [];
    const adapter = makeAdapter(
      { s: 'string', l: 'list', h: 'hash', z: 'zset', j: 'ReJSON-RL' },
      () => [null, 3],
      sent,
    );

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    const sizeCommands = sent.filter((c) => /^(STRLEN|LLEN|HLEN|SCARD|ZCARD|XLEN)$/.test(c));
    expect(sizeCommands.sort()).toEqual(['HLEN', 'LLEN', 'STRLEN', 'ZCARD']);
    expect(sent.filter((c) => c.startsWith('OBJECT'))).toEqual(Array(5).fill('OBJECT IDLETIME'));
    expect(result.keyDetails?.find((k) => k.keyName === 'l')?.cardinality).toBe(3);
  });

  it('drops a type that went stale and ignores inherited type names', async () => {
    const sent: string[] = [];
    const wrongType = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    const adapter = makeAdapter({ moved: 'string', proto: '__proto__' }, (command) =>
      command === 'STRLEN' ? [wrongType, null] : [null, 3],
      sent,
    );

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    const byName = new Map(result.keyDetails?.map((k) => [k.keyName, k]));
    expect(byName.get('moved')?.keyType).toBeNull();
    expect(byName.get('proto')).toEqual(expect.objectContaining({ keyType: '__proto__', cardinality: null }));
    expect(sent.filter((c) => c === 'STRLEN')).toHaveLength(1);
  });

  it('reports a key deleted after the batch TYPE as gone', async () => {
    const adapter = makeAdapter({ gone: 'string', kept: 'string' }, (command, key) => {
      if (command === 'TTL') return [null, key === 'gone' ? -2 : -1];
      return [null, key === 'gone' && command === 'STRLEN' ? 0 : 3];
    }, []);

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    const byName = new Map(result.keyDetails?.map((k) => [k.keyName, k]));
    expect(byName.get('gone')).toEqual(expect.objectContaining({ keyType: 'none', cardinality: null }));
    expect(byName.get('kept')).toEqual(expect.objectContaining({ keyType: 'string', cardinality: 3 }));
  });

  it('switches to OBJECT FREQ once IDLETIME errors under an LFU policy', async () => {
    const sent: string[] = [];
    const lfuError = new Error('ERR An LFU maxmemory policy is selected, idle time not tracked.');
    const adapter = makeAdapter({ a: 'string', b: 'string', c: 'string' }, (command) =>
      command === 'OBJECT IDLETIME' ? [lfuError, null] : [null, 7],
      sent,
    );

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(sent.filter((c) => c.startsWith('OBJECT'))).toEqual([
      'OBJECT IDLETIME',
      'OBJECT FREQ',
      'OBJECT FREQ',
      'OBJECT FREQ',
    ]);
    expect(result.keyDetails?.filter((k) => k.freqScore === 7)).toHaveLength(3);
  });

  it('keeps OBJECT IDLETIME when a key fails for another reason', async () => {
    const sent: string[] = [];
    const noperm = new Error("NOPERM this user has no permissions to access the 'b' key");
    const adapter = makeAdapter({ a: 'string', b: 'string', c: 'string' }, (command, key) =>
      command === 'OBJECT IDLETIME' && key === 'b' ? [noperm, null] : [null, 7],
      sent,
    );

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(sent.filter((c) => c.startsWith('OBJECT'))).toEqual(Array(3).fill('OBJECT IDLETIME'));
    expect(result.keyDetails?.filter((k) => k.idleSeconds === 7)).toHaveLength(2);
  });

  it('still scans the batch when the TYPE pipeline fails', async () => {
    const sent: string[] = [];
    const adapter = makeAdapter({ a: 'string', b: 'list' }, () => [null, 3], sent);
    const client = (adapter as unknown as { _client: { pipeline: () => { exec: () => Promise<unknown> } } })._client;
    const pipeline = client.pipeline;
    let first = true;
    client.pipeline = () => {
      const chain = pipeline();
      if (first) {
        first = false;
        chain.exec = () => Promise.reject(new Error('connection reset'));
      }
      return chain;
    };

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(result.scanned).toBe(2);
    expect(result.keyDetails?.every((k) => k.cardinality === null)).toBe(true);
  });
});

describe('UnifiedDatabaseAdapter.collectKeyAnalytics — multiple logical databases', () => {
  const scanChain = fakeKeyPipeline((command) => [null, command === 'TTL' ? -1 : 10]);

  function fakeScanClient(keys: string[]) {
    return {
      dbsize: jest.fn().mockResolvedValue(keys.length),
      scan: jest.fn().mockResolvedValue(['0', keys]),
      pipeline: scanChain,
      connect: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
  }

  function makeMultiDbAdapter(options: {
    dbIndex?: number;
    keyspaceInfo: string;
    ownKeys: string[];
    scratchKeysByDb?: Record<number, string[]>;
  }) {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const ownClient = {
      ...fakeScanClient(options.ownKeys),
      info: jest.fn().mockResolvedValue(`# Keyspace\r\n${options.keyspaceInfo}`),
    };
    (adapter as unknown as { _client: unknown })._client = ownClient;
    (adapter as unknown as { config: unknown }).config = { dbIndex: options.dbIndex };
    (adapter as unknown as { graphMemoryCache: Map<string, unknown> }).graphMemoryCache = new Map();
    // Object.create bypasses the constructor, so the logger field is unset.
    (adapter as unknown as { logger: unknown }).logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    };
    const scratchClients: Record<number, ReturnType<typeof fakeScanClient>> = {};
    const createValkeyClient = jest.fn((_name: string, db?: number) => {
      const client = fakeScanClient(options.scratchKeysByDb?.[db ?? 0] ?? []);
      scratchClients[db ?? 0] = client;
      return client;
    });
    (adapter as unknown as { createValkeyClient: unknown }).createValkeyClient =
      createValkeyClient;
    return { adapter, ownClient, scratchClients, createValkeyClient };
  }

  it('scans every non-empty database from INFO keyspace, visiting siblings with a scratch client', async () => {
    const { adapter, ownClient, scratchClients, createValkeyClient } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo:
        'db0:keys=2,expires=0,avg_ttl=0\r\ndb2:keys=3,expires=1,avg_ttl=0\r\n',
      ownKeys: ['a:1', 'a:2'],
      scratchKeysByDb: { 2: ['b:1', 'b:2', 'b:3'] },
    });

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(results.map((r) => r.db)).toEqual([0, 2]);
    expect(results.map((r) => r.dbSize)).toEqual([2, 3]);
    // db0 is the connection's own database: scanned on the shared client.
    expect(ownClient.scan).toHaveBeenCalled();
    // db2 is visited through a short-lived client SELECTed onto db 2…
    expect(createValkeyClient).toHaveBeenCalledTimes(1);
    expect(createValkeyClient.mock.calls[0][1]).toBe(2);
    expect(scratchClients[2].connect).toHaveBeenCalled();
    // …which is closed afterwards.
    expect(scratchClients[2].quit).toHaveBeenCalled();
  });

  it('finds keys outside the configured database even when that database is empty (BetterDB feedback)', async () => {
    const { adapter, ownClient } = makeMultiDbAdapter({
      dbIndex: 0,
      // db0 holds nothing, so INFO keyspace does not list it at all.
      keyspaceInfo: 'db1:keys=3,expires=0,avg_ttl=0\r\n',
      ownKeys: [],
      scratchKeysByDb: { 1: ['user:1', 'user:2', 'user:3'] },
    });

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    // The old implementation DBSIZE'd db0, got 0 and gave up. Now db1 is found.
    expect(results.map((r) => r.db)).toEqual([1]);
    expect(results[0].dbSize).toBe(3);
    expect(results[0].scanned).toBe(3);
    expect(ownClient.scan).not.toHaveBeenCalled();
  });

  it('falls back to scanning the connected database when INFO keyspace is unavailable', async () => {
    const { adapter, ownClient, createValkeyClient } = makeMultiDbAdapter({
      dbIndex: 4,
      keyspaceInfo: '',
      ownKeys: ['k:1'],
    });
    ownClient.info.mockRejectedValue(new Error('NOPERM'));

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(results).toHaveLength(1);
    expect(results[0].db).toBe(4);
    expect(ownClient.scan).toHaveBeenCalled();
    expect(createValkeyClient).not.toHaveBeenCalled();
  });

  it('keeps scanning the remaining databases when one database scan fails', async () => {
    const { adapter, scratchClients } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo:
        'db0:keys=1,expires=0,avg_ttl=0\r\ndb1:keys=1,expires=0,avg_ttl=0\r\ndb2:keys=1,expires=0,avg_ttl=0\r\n',
      ownKeys: ['a:1'],
      scratchKeysByDb: { 1: ['b:1'], 2: ['c:1'] },
    });
    // db1's scratch connect blows up; db0 and db2 must still come back.
    const original = (adapter as unknown as { createValkeyClient: jest.Mock })
      .createValkeyClient;
    original.mockImplementationOnce((_name: string, _db?: number) => {
      const broken = fakeScanClient([]);
      broken.connect.mockRejectedValue(new Error('connection refused'));
      return broken;
    });

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(results.map((r) => r.db)).toEqual([0, 2]);
    expect(scratchClients[2].quit).toHaveBeenCalled();
  });

  it('keeps scanning sibling databases when the own-db scan fails', async () => {
    const { adapter, ownClient, scratchClients } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo: 'db0:keys=1,expires=0,avg_ttl=0\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n',
      ownKeys: ['a:1'],
      scratchKeysByDb: { 1: ['b:1'] },
    });
    ownClient.scan.mockRejectedValue(new Error('own-db scan failed'));

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    // The old implementation let an own-db failure propagate out of the loop
    // and discard sibling results. Now db1 still comes back.
    expect(results.map((r) => r.db)).toEqual([1]);
    expect(scratchClients[1].quit).toHaveBeenCalled();
  });

  it('treats a scratch client that cannot SELECT the target db as a failed scan', async () => {
    const { adapter, scratchClients } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo: 'db0:keys=1,expires=0,avg_ttl=0\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n',
      ownKeys: ['a:1'],
      scratchKeysByDb: { 1: ['b:1'] },
    });
    // iovalkey silently swallows a failed handshake SELECT; the explicit
    // post-connect select() is what must surface this as a failure.
    const original = (adapter as unknown as { createValkeyClient: jest.Mock })
      .createValkeyClient;
    original.mockImplementationOnce((_name: string, _db?: number) => {
      const restricted = fakeScanClient(['b:1']);
      restricted.select.mockRejectedValue(new Error('NOPERM this user has no permissions'));
      return restricted;
    });

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    // db1 must not appear tagged with data actually scanned from db0.
    expect(results.map((r) => r.db)).toEqual([0]);
    expect(scratchClients[1]).toBeUndefined();
  });

  it('splits the sample budget across databases proportionally to their key counts', async () => {
    const { adapter } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo:
        'db0:keys=30000,expires=0,avg_ttl=0\r\ndb1:keys=10000,expires=0,avg_ttl=0\r\n',
      ownKeys: ['a:1'],
      scratchKeysByDb: { 1: ['b:1'] },
    });
    const scanDatabase = jest
      .spyOn(
        adapter as unknown as {
          scanDatabase: (c: unknown, db: number, o: { sampleSize: number }) => Promise<unknown>;
        },
        'scanDatabase',
      )
      .mockImplementation(async (_c, db) => ({ dbSize: 1, scanned: 1, patterns: [], db }));

    await adapter.collectKeyAnalytics({ sampleSize: 1000, scanBatchSize: 100 });

    // 16 populated databases must not mean 16x the scan work: one budget,
    // split by key count (30k:10k -> 750:250), not sampleSize per database.
    expect(scanDatabase.mock.calls.map(([, db, opts]) => [db, opts.sampleSize])).toEqual([
      [0, 750],
      [1, 250],
    ]);
  });

  it('skips a sibling database instead of dialing the raw host when the SSH tunnel is down', async () => {
    const { adapter, createValkeyClient } = makeMultiDbAdapter({
      dbIndex: 0,
      keyspaceInfo: 'db0:keys=1,expires=0,avg_ttl=0\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n',
      ownKeys: ['a:1'],
      scratchKeysByDb: { 1: ['b:1'] },
    });
    (adapter as unknown as { usesTunnel: boolean }).usesTunnel = true;
    (adapter as unknown as { tunnelActive: boolean }).tunnelActive = false;

    const results = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(results.map((r) => r.db)).toEqual([0]);
    expect(createValkeyClient).not.toHaveBeenCalled();
  });
});

describe('UnifiedDatabaseAdapter — configured dbIndex', () => {
  it('passes dbIndex through to the Valkey client options (BetterDB feedback)', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'localhost',
      port: 6379,
      username: 'default',
      password: '',
      dbIndex: 3,
    });
    // lazyConnect: no socket is opened; only the options are inspected.
    const client = adapter.getClient() as unknown as { options: { db?: number } };
    expect(client.options.db).toBe(3);
  });

  it('defaults to db0 when no dbIndex is configured', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'localhost',
      port: 6379,
      username: 'default',
      password: '',
    });
    const client = adapter.getClient() as unknown as { options: { db?: number } };
    expect(client.options.db).toBe(0);
  });

  function makeConnectAdapter(selectError?: Error) {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const client = {
      options: { host: 'localhost', port: 6379 },
      connect: jest.fn().mockResolvedValue(undefined),
      select: selectError
        ? jest.fn().mockRejectedValue(selectError)
        : jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    (adapter as unknown as { _client: unknown })._client = client;
    (adapter as unknown as { config: unknown }).config = { dbIndex: 5 };
    (adapter as unknown as { graphMemoryCache: Map<string, unknown> }).graphMemoryCache = new Map();
    (adapter as unknown as { usesTunnel: boolean }).usesTunnel = false;
    (adapter as unknown as { tunnelActive: boolean }).tunnelActive = false;
    (adapter as unknown as { detectCapabilities: unknown }).detectCapabilities = jest
      .fn()
      .mockResolvedValue(undefined);
    const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (adapter as unknown as { logger: unknown }).logger = logger;
    return { adapter, client, logger };
  }

  it('falls back to db0 with a warning when SELECT on the configured dbIndex is rejected', async () => {
    // Availability over strictness: dbIndex was stored-but-ignored before it
    // was honored, so stray values must not take whole connections down on
    // upgrade (out-of-range index, ACL without +select, pre-Valkey-9 cluster).
    const { adapter, client, logger } = makeConnectAdapter(
      new Error('ERR DB index is out of range'),
    );

    await (adapter as unknown as { doConnect(): Promise<void> }).doConnect();

    expect(adapter.getActiveDbIndex()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to db0'));
    // The client's recorded SELECT target is pinned back to db0 so an
    // auto-reconnect cannot silently retry the rejected index.
    expect(client.select).toHaveBeenCalledWith(0);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('fails the connect on a transport error during SELECT instead of mislabeling the db', async () => {
    // iovalkey records the SELECT target when the command is SENT and
    // re-selects it on auto-reconnect — a dropped connection mid-SELECT must
    // therefore fail the connect, not fall back: the client would come back
    // on dbN while activeDbIndex claimed db0, mislabeling every scan.
    const { adapter, client } = makeConnectAdapter(new Error('Connection is closed.'));

    await expect(
      (adapter as unknown as { doConnect(): Promise<void> }).doConnect(),
    ).rejects.toThrow('Connection is closed.');

    expect(client.disconnect).toHaveBeenCalled();
  });

  it('reports the configured dbIndex as active when its SELECT succeeds', async () => {
    const { adapter, client } = makeConnectAdapter();

    await (adapter as unknown as { doConnect(): Promise<void> }).doConnect();

    expect(client.select).toHaveBeenCalledWith(5);
    expect(adapter.getActiveDbIndex()).toBe(5);
  });

  it('disconnects the leaked client when a post-connect step fails', async () => {
    const { adapter, client } = makeConnectAdapter();
    (adapter as unknown as { detectCapabilities: jest.Mock }).detectCapabilities = jest
      .fn()
      .mockRejectedValue(new Error('NOPERM'));

    await expect(
      (adapter as unknown as { doConnect(): Promise<void> }).doConnect(),
    ).rejects.toThrow('NOPERM');

    // The socket connected and authenticated before the failure; without an
    // explicit disconnect it would stay open, leaking one live session per
    // failed attempt.
    expect(client.disconnect).toHaveBeenCalled();
    expect((adapter as unknown as { _client: unknown })._client).toBeNull();
  });
});

describe('UnifiedDatabaseAdapter — FalkorDB graph keys', () => {
  const MB = 1024 * 1024;
  type Reply = [Error | null, unknown];

  function makeGraphAdapter(opts: {
    keyType: string;
    memoryUsage: number;
    graphMemory: Reply;
    graphStats: Reply;
    keys?: string[];
  }) {
    const keys = opts.keys ?? ['social'];
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const graphCalls: string[] = [];
    const pipeline = fakeKeyPipeline(
      (command) => {
        if (command.startsWith('GRAPH.')) {
          graphCalls.push(command);
          return command === 'GRAPH.MEMORY' ? opts.graphMemory : opts.graphStats;
        }
        if (command === 'MEMORY USAGE') return [null, opts.memoryUsage];
        return [null, command === 'TTL' ? -1 : 5];
      },
      [],
      Object.fromEntries(keys.map((key) => [key, opts.keyType])),
    );
    (adapter as unknown as { _client: unknown })._client = {
      dbsize: jest.fn().mockResolvedValue(keys.length),
      scan: jest.fn().mockResolvedValue(['0', keys]),
      info: jest.fn().mockResolvedValue(`# Keyspace\r\ndb0:keys=${keys.length},expires=0,avg_ttl=0`),
      pipeline,
    };
    (adapter as unknown as { config: unknown }).config = {};
    (adapter as unknown as { graphMemoryCache: Map<string, unknown> }).graphMemoryCache = new Map();
    return { adapter, graphCalls };
  }

  const graphMemoryReply: Reply = [
    null,
    ['total_graph_sz_mb', 3, 'label_matrices_sz_mb', 0, 'amortized_node_attributes_by_label_sz_mb', ['Person', 0]],
  ];
  const graphStatsReply: Reply = [null, [['nodeCount + relCount'], [[54995]], ['Cached execution: 0']]];

  it('sizes a graphdata key with GRAPH.MEMORY USAGE and node + edge cardinality', async () => {
    const { adapter } = makeGraphAdapter({
      keyType: 'graphdata',
      memoryUsage: 32,
      graphMemory: graphMemoryReply,
      graphStats: graphStatsReply,
    });

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(result.keyDetails?.[0]).toMatchObject({ keyType: 'graphdata', memoryBytes: 3 * MB, cardinality: 54995 });
    expect(result.patterns[0].totalMemory).toBe(3 * MB);
  });

  it('keeps MEMORY USAGE when GRAPH.MEMORY fails or reports under 1 MB', async () => {
    for (const graphMemory of [
      [new Error('ERR unknown command'), null] as Reply,
      [null, ['total_graph_sz_mb', 0]] as Reply,
    ]) {
      const { adapter } = makeGraphAdapter({
          keyType: 'graphdata',
        memoryUsage: 24,
        graphMemory,
        graphStats: [new Error('ERR boom'), null],
      });

      const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

      expect(result.keyDetails?.[0]).toMatchObject({ memoryBytes: 24, cardinality: null });
    }
  });

  it('issues no GRAPH.* commands for non-graph keys', async () => {
    const { adapter, graphCalls } = makeGraphAdapter({
      keyType: 'hash',
      memoryUsage: 32,
      graphMemory: graphMemoryReply,
      graphStats: graphStatsReply,
    });

    const [result] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });

    expect(graphCalls).toEqual([]);
    expect(result.keyDetails?.[0]).toMatchObject({ memoryBytes: 32 });
  });

  it('reuses a GRAPH.MEMORY result within the TTL and re-measures after it', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { adapter, graphCalls } = makeGraphAdapter({
      keyType: 'graphdata',
      memoryUsage: 32,
      graphMemory: graphMemoryReply,
      graphStats: graphStatsReply,
    });
    const memoryProbes = () => graphCalls.filter((c) => c === 'GRAPH.MEMORY').length;

    await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });
    const [cached] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });
    expect(memoryProbes()).toBe(1);
    expect(cached.keyDetails?.[0]).toMatchObject({ memoryBytes: 3 * MB, cardinality: 54995 });

    now.mockReturnValue(1_000_000 + GRAPH_MEMORY_TTL_MS);
    await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });
    expect(memoryProbes()).toBe(2);
    now.mockRestore();
  });

  it('caps fresh GRAPH.MEMORY probes per collection but counts every graph', async () => {
    const keys = Array.from({ length: GRAPH_MEMORY_PROBES_PER_SCAN + 5 }, (_, i) => `g${i}`);
    const { adapter, graphCalls } = makeGraphAdapter({
      keyType: 'graphdata',
      memoryUsage: 32,
      graphMemory: graphMemoryReply,
      graphStats: graphStatsReply,
      keys,
    });

    const [first] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });
    expect(graphCalls.filter((c) => c === 'GRAPH.MEMORY')).toHaveLength(GRAPH_MEMORY_PROBES_PER_SCAN);
    expect(graphCalls.filter((c) => c === 'GRAPH.RO_QUERY')).toHaveLength(keys.length);
    const sizes = first.keyDetails?.map((d) => d.memoryBytes);
    expect(sizes?.filter((b) => b === 3 * MB)).toHaveLength(GRAPH_MEMORY_PROBES_PER_SCAN);
    expect(sizes?.filter((b) => b === 32)).toHaveLength(5);

    // The next collection measures the 5 left over and reuses the cached 20.
    const [second] = await adapter.collectKeyAnalytics({ sampleSize: 100, scanBatchSize: 100 });
    expect(graphCalls.filter((c) => c === 'GRAPH.MEMORY')).toHaveLength(keys.length);
    expect(second.keyDetails?.every((d) => d.memoryBytes === 3 * MB)).toBe(true);
  });
});

describe('UnifiedDatabaseAdapter — TLS material and certificate auth', () => {
  // lazyConnect means the constructor builds the iovalkey client without
  // dialing, so the options it was given can be inspected directly.
  const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
  const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';

  it('sends AUTH credentials in password mode (unchanged behaviour)', () => {
    const adapter = new UnifiedDatabaseAdapter({ host: 'db.example.com', port: 6379, username: 'default', password: '' });
    const options = adapter.getClient().options;
    expect(options.username).toBe('default');
    expect(options.tls).toBeUndefined();
  });

  it('passes the user-supplied CA, certificate, key and passphrase to the TLS socket unmodified', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.example.com',
      port: 6379,
      username: 'monitor',
      password: 'pw',
      tls: true,
      tlsConfig: { ca: CA, cert: CERT, key: KEY, passphrase: 'secret' },
    });
    const tls = adapter.getClient().options.tls!;
    expect(tls.ca).toBe(CA);
    expect(tls.cert).toBe(CERT);
    expect(tls.key).toBe(KEY);
    expect(tls.passphrase).toBe('secret');
    // SNI is still applied alongside the material.
    expect(tls.servername).toBe('db.example.com');
    // Server verification is never weakened.
    expect(tls.rejectUnauthorized).toBeUndefined();
  });

  it('omits username and password entirely in certificate mode so no AUTH is sent', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.example.com',
      port: 6379,
      username: 'default',
      password: '',
      tls: true,
      tlsConfig: { cert: CERT, key: KEY },
      authMode: 'certificate',
    });
    const options = adapter.getClient().options;
    // iovalkey stores an absent credential as null; what matters is that it is
    // falsy, which is the condition under which it skips AUTH entirely.
    expect(options.username).toBeFalsy();
    expect(options.password).toBeFalsy();
    expect(options.tls?.cert).toBe(CERT);
  });

  it('defers an invalid auth/TLS combination to connect() instead of throwing from the constructor', async () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.example.com',
      port: 6379,
      tls: true,
      authMode: 'certificate',
    });
    await expect(adapter.connect()).rejects.toThrow(/client certificate and private key/);
  });

  it('reports the ACL user from ACL WHOAMI after connect, tolerating servers without ACL', async () => {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const call = jest.fn(() => Promise.resolve('app-monitor'));
    (adapter as unknown as { _client: { call: typeof call } })._client = { call };
    const probe = (adapter as unknown as { probeAuthenticatedUser(): Promise<string | undefined> }).probeAuthenticatedUser;
    await expect(probe.call(adapter)).resolves.toBe('app-monitor');
    expect(call).toHaveBeenCalledWith('ACL', 'WHOAMI');

    call.mockImplementationOnce(() => Promise.reject(new Error("ERR unknown command 'ACL'")));
    await expect(probe.call(adapter)).resolves.toBeUndefined();
  });
});

describe('UnifiedDatabaseAdapter — certificate rotation and probe deadline', () => {
  // Real material: refreshes validate the pair before adopting it.
  let pairA: TlsPair;
  let pairB: TlsPair;
  const originalDir = process.env.BETTERDB_TLS_CERT_DIR;
  let certDir: string;

  beforeAll(() => {
    pairA = generateTlsPair('node-a');
    pairB = generateTlsPair('node-b');
  });

  beforeEach(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-rotation-'));
    fs.writeFileSync(path.join(certDir, 'client.crt'), pairA.cert);
    fs.writeFileSync(path.join(certDir, 'client.key'), pairA.key);
    process.env.BETTERDB_TLS_CERT_DIR = certDir;
  });

  afterEach(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.BETTERDB_TLS_CERT_DIR;
    else process.env.BETTERDB_TLS_CERT_DIR = originalDir;
    jest.useRealTimers();
  });

  const fileAdapter = () =>
    new UnifiedDatabaseAdapter({
      host: 'db.example.com',
      port: 6379,
      tls: true,
      authMode: 'certificate',
      tlsConfig: { source: 'file', certPath: 'client.crt', keyPath: 'client.key' },
    });
  // An in-place rewrite within one filesystem timestamp tick can keep the stat
  // fingerprint; give every write a distinct mtime so change detection is deterministic.
  let mtime = 1_700_000_000;
  const writeFile = (name: string, content: string) => {
    const file = path.join(certDir, name);
    fs.writeFileSync(file, content);
    mtime += 1;
    fs.utimesSync(file, mtime, mtime);
  };
  const writePair = (pair: TlsPair) => {
    writeFile('client.crt', pair.cert);
    writeFile('client.key', pair.key);
  };
  const certOf = (holder: { options: { tls?: { cert?: unknown } } }) => (holder.options.tls?.cert as Buffer | string | undefined)?.toString();

  it('adopts a mismatched pair at construction with a warning rather than failing, so the reconnect refresh can heal it', () => {
    // Files caught mid-rotation at boot: certificate B next to key A.
    writeFile('client.crt', pairB.cert);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const adapter = fileAdapter();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TLS material is not usable.*re-read before each reconnect/));
      const material = (adapter as unknown as { tlsMaterial: { cert?: Buffer | string }; tlsSetupError: Error | null });
      expect(material.tlsSetupError).toBeNull();
      expect(material.tlsMaterial.cert?.toString()).toBe(pairB.cert);

      // The key lands: the forced re-read before a reconnect adopts the complete pair.
      writeFile('client.key', pairB.key);
      (adapter as unknown as { refreshTlsMaterial(force: boolean): void }).refreshTlsMaterial(true);
      const client = (adapter as unknown as { _client: { options: { tls?: { cert?: unknown; key?: unknown } } } })._client;
      expect(certOf(client)).toBe(pairB.cert);
      expect((client.options.tls?.key as Buffer | string | undefined)?.toString()).toBe(pairB.key);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not record a fingerprint for unusable material, so a plain refresh re-reads it', () => {
    writeFile('client.crt', pairB.cert);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const adapter = fileAdapter();
      const internals = adapter as unknown as {
        tlsMaterialFingerprint: string | undefined;
        tlsMaterialCheckedAt: number;
        tlsMaterial: { cert?: Buffer | string; key?: Buffer | string };
        refreshTlsMaterial(force?: boolean): void;
      };
      expect(internals.tlsMaterialFingerprint).toBeUndefined();

      // Simulate the race: the key landed after the read, so the files on disk
      // are now complete and a fingerprint taken now would match them.
      writeFile('client.key', pairB.key);
      internals.tlsMaterialCheckedAt = 0;
      internals.refreshTlsMaterial();
      expect(internals.tlsMaterial.key?.toString()).toBe(pairB.key);
      expect(internals.tlsMaterialFingerprint).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('re-reads file-sourced material when iovalkey is about to reconnect', () => {
    const adapter = fileAdapter();
    const client = adapter.getClient();
    expect(certOf(client)).toBe(pairA.cert);

    writePair(pairB);
    client.emit('reconnecting');

    expect(certOf(client)).toBe(pairB.cert);
    // SNI survives the refresh.
    expect(client.options.tls?.servername).toBe('db.example.com');
  });

  it('presents rotated files on every new socket, not only after a reconnect of the main client', () => {
    jest.useFakeTimers();
    const adapter = fileAdapter();
    const newSocket = () =>
      (adapter as unknown as { createValkeyClient(name: string): { options: { tls?: { cert?: Buffer | string; servername?: string } } } })
        .createValkeyClient('scratch');
    // A cached CLI client is kept current as well (it reconnects on its own).
    const cliClient = { options: {} as { tls?: { cert?: Buffer | string } }, on: jest.fn() };
    (adapter as unknown as { cliClient: unknown }).cliClient = cliClient;
    expect(certOf(newSocket())).toBe(pairA.cert);

    writePair(pairB);

    // Within the recheck window nothing is stat-ed: scratch clients stay cheap.
    expect(certOf(newSocket())).toBe(pairA.cert);

    jest.advanceTimersByTime(TLS_MATERIAL_RECHECK_MS + 1);
    // A scratch client (key analytics, CLI) built now carries the new material...
    expect(certOf(newSocket())).toBe(pairB.cert);
    // ...and so do the long-lived clients' option objects (cluster discovery copies the main one).
    expect(certOf(adapter.getClient())).toBe(pairB.cert);
    expect(adapter.getClient().options.tls?.servername).toBe('db.example.com');
    expect(certOf(cliClient)).toBe(pairB.cert);
  });

  it('keeps the previous pair when a rotation is caught between writing the certificate and the key', () => {
    const adapter = fileAdapter();
    const client = adapter.getClient();

    // Only the certificate has been replaced so far: the files do not match.
    writeFile('client.crt', pairB.cert);
    client.emit('reconnecting');
    expect(certOf(client)).toBe(pairA.cert);
    expect(client.options.tls?.key?.toString()).toBe(pairA.key);

    // The key lands: the next refresh adopts the complete new pair.
    writeFile('client.key', pairB.key);
    client.emit('reconnecting');
    expect(certOf(client)).toBe(pairB.cert);
    expect(client.options.tls?.key?.toString()).toBe(pairB.key);
  });

  it('re-reads before every reconnect but logs a change only when the files changed', () => {
    const adapter = fileAdapter();
    const client = adapter.getClient();
    const read = jest.spyOn(tlsMaterial, 'resolveTlsMaterial');
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const changedLogs = () =>
      log.mock.calls.filter(([m]) => /TLS files changed on disk/.test(String(m))).length;
    try {
      client.emit('reconnecting');
      client.emit('reconnecting');
      expect(read).toHaveBeenCalledTimes(2);
      expect(changedLogs()).toBe(0);

      writeFile('client.crt', pairA.cert);
      client.emit('reconnecting');
      expect(read).toHaveBeenCalledTimes(3);
      expect(changedLogs()).toBe(1);
    } finally {
      read.mockRestore();
      log.mockRestore();
    }
  });

  it('installs freshly read material on a forced reconnect when the fingerprint is unchanged', () => {
    const fingerprint = jest.spyOn(tlsMaterial, 'tlsMaterialFingerprint').mockReturnValue('constant');
    try {
      const adapter = fileAdapter();
      const client = adapter.getClient();
      writePair(pairB);
      client.emit('reconnecting');
      expect(certOf(client)).toBe(pairB.cert);
    } finally {
      fingerprint.mockRestore();
    }
  });

  it('warns once while the files stay unusable and logs when they recover', () => {
    const adapter = fileAdapter();
    const client = adapter.getClient();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      writeFile('client.crt', pairB.cert);
      client.emit('reconnecting');
      client.emit('reconnecting');
      expect(warn.mock.calls.filter(([m]) => /Keeping previously loaded TLS files/.test(String(m)))).toHaveLength(1);

      writeFile('client.key', pairB.key);
      client.emit('reconnecting');
      expect(log).toHaveBeenCalledWith('TLS files on disk are usable again');
      expect(certOf(client)).toBe(pairB.cert);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('keeps the previously loaded material when the rotated file is unreadable', () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: 'db.example.com',
      port: 6379,
      tls: true,
      tlsConfig: { source: 'file', certPath: 'client.crt', keyPath: 'client.key' },
    });
    const client = adapter.getClient();
    fs.rmSync(path.join(certDir, 'client.crt'));
    client.emit('reconnecting');
    expect(certOf(client)).toBe(pairA.cert);
  });

  it('gives up on ACL WHOAMI after the deadline instead of hanging connect()', async () => {
    jest.useFakeTimers();
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const call = jest.fn(() => new Promise<never>(() => undefined));
    (adapter as unknown as { _client: { call: typeof call } })._client = { call };
    const probe = (adapter as unknown as { probeAuthenticatedUser(): Promise<string | undefined> }).probeAuthenticatedUser;

    const pending = probe.call(adapter);
    jest.advanceTimersByTime(WHOAMI_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('UnifiedDatabaseAdapter — deferred TLS setup and single WHOAMI per connect', () => {
  const CERT = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n';
  const KEY = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n';
  const originalDir = process.env.BETTERDB_TLS_CERT_DIR;
  let certDir: string;

  beforeEach(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-late-mount-'));
    process.env.BETTERDB_TLS_CERT_DIR = certDir;
  });

  afterEach(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.BETTERDB_TLS_CERT_DIR;
    else process.env.BETTERDB_TLS_CERT_DIR = originalDir;
  });

  it('recovers when the certificate files appear after construction (late-mounted secret)', async () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: '127.0.0.1',
      port: 1,
      tls: true,
      authMode: 'certificate',
      tlsConfig: { source: 'file', certPath: 'client.crt', keyPath: 'client.key' },
    });
    // Files missing: the deferred error surfaces on connect, every time.
    await expect(adapter.connect()).rejects.toThrow(/Client certificate file 'client.crt' not found/);
    await expect(adapter.connect()).rejects.toThrow(/Client certificate file 'client.crt' not found/);

    fs.writeFileSync(path.join(certDir, 'client.crt'), CERT);
    fs.writeFileSync(path.join(certDir, 'client.key'), KEY);

    // Now the material loads and the dial proceeds (and fails on the dead port instead).
    let message = '';
    try {
      await adapter.connect();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/not found/);
    // The failed dial discards the client, so inspect the loaded material directly.
    const material = (adapter as unknown as { tlsMaterial: { cert?: Buffer | string } }).tlsMaterial;
    expect(material.cert?.toString()).toBe(CERT);
    await adapter.disconnect().catch(() => undefined);
  });

  it('keeps a permanent configuration error permanent', async () => {
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: 1, tls: true, authMode: 'certificate' });
    await expect(adapter.connect()).rejects.toThrow(/client certificate and private key/);
    await expect(adapter.connect()).rejects.toThrow(/client certificate and private key/);
  });

  it('does not probe WHOAMI on the initial ready (doConnect owns that), only on later reconnects', () => {
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: 1, username: 'default', password: '' });
    const probe = jest
      .spyOn(adapter as unknown as { probeAuthenticatedUser: () => Promise<string | undefined> }, 'probeAuthenticatedUser')
      .mockResolvedValue('app');
    const client = adapter.getClient();

    client.emit('ready');
    expect(probe).not.toHaveBeenCalled();

    client.emit('ready');
    expect(probe).toHaveBeenCalledTimes(1);
  });

});

describe('UnifiedDatabaseAdapter own client ids', () => {
  type Client = ReturnType<UnifiedDatabaseAdapter['getClient']>;
  type Reply = number | string | null | Error;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Every client answers CLIENT ID from its own queue; other commands (the
  // WHOAMI probe on a reconnect) get an empty reply.
  function answers(client: Client): { replies: Reply[]; call: jest.SpyInstance } {
    const replies: Reply[] = [];
    const call = jest.spyOn(client, 'call').mockImplementation(async (command: string) => {
      if (command !== 'CLIENT') return undefined;
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    });
    return { replies, call };
  }

  function makeAdapter() {
    const adapter = new UnifiedDatabaseAdapter({ host: '127.0.0.1', port: 1, username: 'default', password: '' });
    const scratch = (name: string) =>
      (adapter as unknown as { createValkeyClient(name: string): Client }).createValkeyClient(name);
    const ids = () => adapter.getOwnClientIds().map((own) => own.id);
    const ready = async (client: Client, queue: Reply[], reply: Reply) => {
      queue.push(reply);
      client.emit('ready');
      await settle();
    };
    return { adapter, scratch, ids, ready };
  }

  it('learns the id of each connection it opens: the main client, its reconnects and scratch clients', async () => {
    const { adapter, scratch, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    const main = answers(client);

    await ready(client, main.replies, 41);
    expect(main.call).toHaveBeenCalledWith('CLIENT', 'ID');
    expect(ids()).toEqual(['41']);

    // A reconnect replaces the id of the same client.
    client.emit('close');
    expect(ids()).toEqual([]);
    await ready(client, main.replies, 57);
    expect(ids()).toEqual(['57']);

    const keyscan = scratch('scratch');
    await ready(keyscan, answers(keyscan).replies, 58);
    expect(ids().sort()).toEqual(['57', '58']);
  });

  it('keeps the main connection known however many scratch clients come and go', async () => {
    const { adapter, scratch, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    await ready(client, answers(client).replies, 41);

    for (let i = 0; i < 70; i++) {
      const keyscan = scratch(`keyscan-${i}`);
      await ready(keyscan, answers(keyscan).replies, 100 + i);
      keyscan.emit('end');
    }

    // The live main connection is still ours and no closed scratch client is.
    expect(ids()).toEqual(['41']);
  });

  it('keeps both ids when two CLIENT ID replies land out of order', async () => {
    const { adapter, scratch, ids } = makeAdapter();
    const client = adapter.getClient();
    const keyscan = scratch('keyscan');
    const pending = new Map<Client, (id: number) => void>();
    for (const c of [client, keyscan]) {
      jest.spyOn(c, 'call').mockImplementation(
        (command: string) =>
          command === 'CLIENT'
            ? new Promise<number>((resolve) => pending.set(c, resolve))
            : Promise.resolve(undefined),
      );
    }

    client.emit('ready');
    keyscan.emit('ready');
    // The scratch client's higher id answers first, then the main client's.
    pending.get(keyscan)!(42);
    await settle();
    pending.get(client)!(41);
    await settle();

    expect(ids().sort()).toEqual(['41', '42']);
  });

  it('ignores a reply that is not a client id', async () => {
    const { adapter, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    const { replies } = answers(client);
    await ready(client, replies, 41);

    for (const reply of [null, 0, -1, '', 'OK'] as Reply[]) {
      await ready(client, replies, reply);
      expect(ids()).toEqual(['41']);
    }
  });

  it('records when the socket connected, not when CLIENT ID answered', async () => {
    const { adapter, ready } = makeAdapter();
    const client = adapter.getClient();
    const { replies } = answers(client);
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      client.emit('connect');
      now.mockReturnValue(5_000);
      await ready(client, replies, 41);
    } finally {
      now.mockRestore();
    }

    expect(adapter.getOwnClientIds()).toEqual([{ id: '41', connectedAt: 1_000 }]);
  });

  it('forgets a connection when its socket closes, even if CLIENT ID answers afterwards', async () => {
    const { adapter, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    const { replies } = answers(client);
    await ready(client, replies, 41);
    client.emit('end');
    expect(ids()).toEqual([]);

    let answer: (id: number) => void = () => undefined;
    jest.spyOn(client, 'call').mockImplementation(
      (command: string) =>
        command === 'CLIENT'
          ? new Promise<number>((resolve) => (answer = resolve))
          : Promise.resolve(undefined),
    );
    client.emit('ready');
    client.emit('close');
    answer(42);
    await settle();

    expect(ids()).toEqual([]);
    expect((adapter as unknown as { ownClients: Map<unknown, unknown> }).ownClients.size).toBe(0);
  });

  it('sends CLIENT ID once when the ACL denies it', async () => {
    const { adapter, scratch, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    const main = answers(client);
    await ready(client, main.replies, new Error("NOPERM this user has no permissions to run the 'client|id' command"));
    expect(ids()).toEqual([]);

    client.emit('close');
    await ready(client, main.replies, 41);
    const keyscan = scratch('keyscan');
    const other = answers(keyscan);
    await ready(keyscan, other.replies, 42);

    const clientIdCalls = (call: jest.SpyInstance) =>
      call.mock.calls.filter(([command, sub]) => command === 'CLIENT' && sub === 'ID');
    expect(clientIdCalls(main.call)).toHaveLength(1);
    expect(clientIdCalls(other.call)).toHaveLength(0);
    expect(ids()).toEqual([]);
  });

  it('asks again on the next ready after a reply lost with the connection', async () => {
    const { adapter, ids, ready } = makeAdapter();
    const client = adapter.getClient();
    const { replies, call } = answers(client);
    await ready(client, replies, new Error('Connection is closed.'));
    expect(ids()).toEqual([]);

    await ready(client, replies, 41);
    expect(call.mock.calls.filter(([command]) => command === 'CLIENT')).toHaveLength(2);
    expect(ids()).toEqual(['41']);
  });
});
