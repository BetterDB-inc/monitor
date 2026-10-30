import {
  GRAPH_MEMORY_PROBES_PER_SCAN,
  GRAPH_MEMORY_TTL_MS,
  QUIT_TIMEOUT_MS,
  UnifiedDatabaseAdapter,
} from './unified.adapter';

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

describe('UnifiedDatabaseAdapter.collectKeyAnalytics — stale keys', () => {
  const DAY = 86400;

  function makeScanAdapter(idleByKey: Record<string, number>) {
    const keys = Object.keys(idleByKey);
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const pipeline = () => {
      let key = '';
      const chain = {
        memory: (_sub: string, name: string) => {
          key = name;
          return chain;
        },
        object: () => chain,
        ttl: () => chain,
        type: () => chain,
        strlen: () => chain,
        llen: () => chain,
        hlen: () => chain,
        scard: () => chain,
        zcard: () => chain,
        xlen: () => chain,
        exec: async () => [
          [null, 100],
          [null, idleByKey[key]],
          [null, null],
          [null, -1],
          [null, 'string'],
          [null, 5],
        ],
      };
      return chain;
    };
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

describe('UnifiedDatabaseAdapter.collectKeyAnalytics — multiple logical databases', () => {
  function scanChain() {
    const chain = {
      memory: () => chain,
      object: () => chain,
      ttl: () => chain,
      type: () => chain,
      strlen: () => chain,
      llen: () => chain,
      hlen: () => chain,
      scard: () => chain,
      zcard: () => chain,
      xlen: () => chain,
      exec: async () => [
        [null, 100],
        [null, 10],
        [null, null],
        [null, -1],
        [null, 'string'],
        [null, 5],
      ],
    };
    return chain;
  }

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
    const pipeline = () => {
      const pipelineCalls: string[] = [];
      const chain = {
        memory: () => chain,
        object: () => chain,
        ttl: () => chain,
        type: () => chain,
        strlen: () => chain,
        llen: () => chain,
        hlen: () => chain,
        scard: () => chain,
        zcard: () => chain,
        xlen: () => chain,
        call: (command: string) => {
          pipelineCalls.push(command);
          graphCalls.push(command);
          return chain;
        },
        exec: async () =>
          pipelineCalls.length > 0
            ? pipelineCalls.map((command) =>
                command === 'GRAPH.MEMORY' ? opts.graphMemory : opts.graphStats,
              )
            : [
                [null, opts.memoryUsage],
                [null, 5],
                [null, null],
                [null, -1],
                [null, opts.keyType],
              ],
      };
      return chain;
    };
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
