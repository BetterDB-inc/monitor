import {
  checkServerlessReadiness,
  clusterMastersWithOwnSlotMoves,
  countSlotOwningMasters,
  findRestrictedCommands,
  isElastiCacheServerlessHost,
  SERVERLESS_RESTRICTED_COMMANDS,
  summarizeServerlessProbes,
} from '../analysis/serverless-readiness';
import type { ServerlessReadinessFacts } from '../analysis/serverless-readiness';

const GIB = 1024 * 1024 * 1024;

function fullCoverage(): ServerlessReadinessFacts['clusterMasters'] {
  return [
    { slots: [[0, 8191]], migratingSlots: 0, importingSlots: 0 },
    { slots: [[8192, 16383]], migratingSlots: 0, importingSlots: 0 },
  ];
}

function facts(overrides: Partial<ServerlessReadinessFacts> = {}): ServerlessReadinessFacts {
  return {
    dbType: 'valkey',
    version: '8.0.2',
    isCluster: true,
    clusterMasterCount: 2,
    masterUsedMemory: [1 * GIB, 1 * GIB],
    sampledKeyBytes: [6, 6],
    databasesBeyondZero: [],
    functionPresence: 'absent',
    missingReplicationCommands: [],
    clusterMasters: fullCoverage(),
    cachedScripts: 0,
    pubsub: { channels: 0, patterns: 0, shardChannels: 0 },
    commandEntries: [],
    unreadProbeNodes: 0,
    unreadCommandLogNodes: 0,
    ...overrides,
  };
}

function titles(f: ServerlessReadinessFacts): string[] {
  return checkServerlessReadiness(f).map((i) => i.title);
}

describe('checkServerlessReadiness', () => {
  it('reports nothing for a ready cluster source', () => {
    expect(checkServerlessReadiness(facts())).toEqual([]);
  });

  it('tags every issue with the serverless_readiness category', () => {
    const issues = checkServerlessReadiness(facts({ cachedScripts: 3, isCluster: false }));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.category).toBe('serverless_readiness');
    }
  });

  describe('key name length', () => {
    it('stays quiet for a 4096-byte key name', () => {
      expect(checkServerlessReadiness(facts({ sampledKeyBytes: [4096] }))).toEqual([]);
    });

    it('blocks on a 4097-byte key name and says it was found in the sample', () => {
      const issues = checkServerlessReadiness(facts({ sampledKeyBytes: [4097, 5] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
      expect(issues[0].detail).toMatch(/in the sample/i);
      expect(issues[0].detail).toMatch(/\b1\b/);
    });

  });

  describe('databases beyond 0', () => {
    it('blocks when keys live outside db0', () => {
      const issues = checkServerlessReadiness(facts({ databasesBeyondZero: ['db3', 'db7'] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
      expect(issues[0].awsToolOnly).toBeUndefined();
      expect(issues[0].detail).toContain('db3, db7');
    });
  });

  describe('function libraries', () => {
    it('blocks when the source holds function libraries', () => {
      const issues = checkServerlessReadiness(facts({ functionPresence: 'present' }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
      expect(issues[0].detail).toMatch(/FCALL/);
    });

    it('warns when function presence could not be determined', () => {
      const issues = checkServerlessReadiness(facts({ functionPresence: 'unknown' }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
    });
  });

  describe('memory per master', () => {
    it('stays quiet at exactly 32 GB on a master', () => {
      expect(checkServerlessReadiness(facts({ masterUsedMemory: [32 * GIB, 1 * GIB] }))).toEqual([]);
    });

    it('warns for the AWS tool only when a master holds more than 32 GB', () => {
      const issues = checkServerlessReadiness(facts({ masterUsedMemory: [32 * GIB + 1, 1 * GIB] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].title).toMatch(/32 GB/);
    });
  });

  describe('memory per cache', () => {
    it('stays quiet at exactly 5,000 GiB in total', () => {
      const memory = Array.from({ length: 160 }, () => 31.25 * GIB);
      expect(
        checkServerlessReadiness(facts({ clusterMasterCount: 160, masterUsedMemory: memory, clusterMasters: [
          { slots: [[0, 16383]], migratingSlots: 0, importingSlots: 0 },
        ] })),
      ).toEqual([]);
    });

    it('blocks when total memory exceeds 5,000 GiB', () => {
      const memory = Array.from({ length: 160 }, () => 31.25 * GIB);
      memory[0] += 1;
      const issues = checkServerlessReadiness(facts({ clusterMasterCount: 160, masterUsedMemory: memory, clusterMasters: [
        { slots: [[0, 16383]], migratingSlots: 0, importingSlots: 0 },
      ] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
      expect(issues[0].awsToolOnly).toBeUndefined();
      expect(issues[0].title).toMatch(/5,000 GiB/);
    });
  });

  describe('master count', () => {
    it('stays quiet at 166 masters', () => {
      expect(titles(facts({ clusterMasterCount: 166 }))).toEqual([]);
    });

    it('warns for the AWS tool only at 167 masters', () => {
      const issues = checkServerlessReadiness(facts({ clusterMasterCount: 167 }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].detail).toMatch(/167/);
    });
  });

  describe('standalone source', () => {
    it('warns that only the AWS tool rejects a standalone source', () => {
      const issues = checkServerlessReadiness(facts({
        isCluster: false,
        clusterMasterCount: 0,
        masterUsedMemory: [1 * GIB],
        clusterMasters: null,
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
    });
  });

  describe('engine version', () => {
    it.each([
      ['redis', '4.0.0'],
      ['redis', '6.2.14'],
      ['redis', '7.2.0'],
      ['redis', '7.2.5'],
      ['valkey', '7.2.0'],
      ['valkey', '7.2.11'],
      ['valkey', '8.1.0'],
      ['valkey', '8.1.4'],
    ] as const)('accepts %s %s', (dbType, version) => {
      expect(checkServerlessReadiness(facts({ dbType, version }))).toEqual([]);
    });

    it.each([
      ['redis', '3.2.12'],
      ['redis', '7.4.0'],
      ['redis', '8.0.0'],
      ['valkey', '7.0.0'],
      ['valkey', '8.2.0'],
      ['valkey', '9.0.0'],
    ] as const)('warns on %s %s for the AWS tool only', (dbType, version) => {
      const issues = checkServerlessReadiness(facts({ dbType, version }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].detail).toContain(version);
    });

    it('skips an unparseable version', () => {
      expect(checkServerlessReadiness(facts({ version: 'unknown' }))).toEqual([]);
    });
  });

  describe('replication commands', () => {
    it('warns for the AWS tool only when PSYNC or REPLCONF is missing', () => {
      const issues = checkServerlessReadiness(facts({ missingReplicationCommands: ['PSYNC'] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].detail).toContain('PSYNC');
    });

    it('skips the check when the probe failed', () => {
      expect(checkServerlessReadiness(facts({ missingReplicationCommands: null }))).toEqual([]);
    });
  });

  describe('slot coverage', () => {
    it('blocks on a slot gap', () => {
      const issues = checkServerlessReadiness(facts({
        clusterMasters: [
          { slots: [[0, 8000]], migratingSlots: 0, importingSlots: 0 },
          { slots: [[8192, 16383]], migratingSlots: 0, importingSlots: 0 },
        ],
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].detail).toMatch(/191 slots? unassigned/);
    });

    it('blocks on overlapping slots', () => {
      const issues = checkServerlessReadiness(facts({
        clusterMasters: [
          { slots: [[0, 8200]], migratingSlots: 0, importingSlots: 0 },
          { slots: [[8192, 16383]], migratingSlots: 0, importingSlots: 0 },
        ],
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].detail).toMatch(/9 slots? owned by more than one master/);
    });

    it('blocks on a slot migration in progress', () => {
      const masters = fullCoverage()!;
      masters[0].migratingSlots = 1;
      masters[1].importingSlots = 1;
      const issues = checkServerlessReadiness(facts({ clusterMasters: masters }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].awsToolOnly).toBe(true);
      expect(issues[0].detail).toMatch(/migrat/i);
    });

    it('skips the check when cluster topology was not read', () => {
      expect(checkServerlessReadiness(facts({ clusterMasters: null }))).toEqual([]);
    });
  });

  describe('cached scripts', () => {
    it('warns when scripts are cached', () => {
      const issues = checkServerlessReadiness(facts({ cachedScripts: 4 }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].detail).toMatch(/NOSCRIPT/);
    });

    it('skips when the count is unknown', () => {
      expect(checkServerlessReadiness(facts({ cachedScripts: null }))).toEqual([]);
    });
  });

  describe('pub/sub subscribers', () => {
    it.each([
      [{ channels: 1, patterns: 0, shardChannels: 0 }],
      [{ channels: 0, patterns: 0, shardChannels: 1 }],
    ])('warns that channel subscribers must resubscribe (%o)', (pubsub) => {
      const issues = checkServerlessReadiness(facts({ pubsub }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].title).toBe('Pub/sub subscribers present');
    });

    it('raises a separate issue for pattern subscribers, which cannot resubscribe', () => {
      const issues = checkServerlessReadiness(facts({ pubsub: { channels: 0, patterns: 2, shardChannels: 0 } }));
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe('Pattern subscribers present');
      expect(issues[0].detail).toMatch(/PSUBSCRIBE/);
      expect(issues[0].detail).not.toMatch(/must resubscribe/);
    });

    it('raises both issues when channel and pattern subscribers are present', () => {
      expect(titles(facts({ pubsub: { channels: 1, patterns: 1, shardChannels: 0 } }))).toEqual([
        'Pub/sub subscribers present',
        'Pattern subscribers present',
      ]);
    });

    it('skips when the counts are unknown', () => {
      expect(checkServerlessReadiness(facts({ pubsub: null }))).toEqual([]);
    });
  });

  describe('restricted commands', () => {
    it('warns and names the restricted commands seen', () => {
      const issues = checkServerlessReadiness(facts({
        commandEntries: [
          { command: ['KEYS', '*'], clientName: 'app' },
          { command: ['client', 'list'], clientName: 'app' },
          { command: ['GET', 'k'], clientName: 'app' },
        ],
      }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].detail).toContain('KEYS');
      expect(issues[0].detail).toContain('CLIENT LIST');
      expect(issues[0].detail).not.toContain('GET');
    });
  });
});

describe('findRestrictedCommands', () => {
  it('matches single-word entries regardless of subcommand', () => {
    expect(findRestrictedCommands([
      { command: ['MEMORY', 'USAGE', 'k'] },
      { command: ['memory', 'stats'] },
      { command: ['FUNCTION', 'LIST'] },
    ])).toEqual([
      { command: 'MEMORY', count: 2 },
      { command: 'FUNCTION', count: 1 },
    ]);
  });

  it('matches two-word entries only on that subcommand', () => {
    expect(findRestrictedCommands([
      { command: ['CLIENT', 'SETNAME', 'x'] },
      { command: ['CLIENT', 'KILL', 'ID', '1'] },
      { command: ['SCRIPT', 'LOAD', 'return 1'] },
      { command: ['SCRIPT', 'KILL'] },
      { command: ['PUBSUB', 'CHANNELS'] },
      { command: ['PUBSUB', 'NUMPAT'] },
    ])).toEqual([
      { command: 'CLIENT KILL', count: 1 },
      { command: 'SCRIPT KILL', count: 1 },
      { command: 'PUBSUB NUMPAT', count: 1 },
    ]);
  });

  it('matches the real CLUSTER ADDSLOTS and CLUSTER DELSLOTS command names', () => {
    expect(findRestrictedCommands([
      { command: ['CLUSTER', 'ADDSLOTS', '1', '2'] },
      { command: ['cluster', 'delslots', '3'] },
    ])).toEqual([
      { command: 'CLUSTER ADDSLOTS', count: 1 },
      { command: 'CLUSTER DELSLOTS', count: 1 },
    ]);
    expect(SERVERLESS_RESTRICTED_COMMANDS).not.toContain('CLUSTER ADDSLOT');
    expect(SERVERLESS_RESTRICTED_COMMANDS).not.toContain('CLUSTER DELSLOT');
  });

  it("ignores entries issued by BetterDB's own clients", () => {
    expect(findRestrictedCommands([
      { command: ['CONFIG', 'GET', 'save'], clientName: 'BetterDB-Migration-Analysis' },
      { command: ['SLOWLOG', 'GET'], clientName: 'BetterDB-Monitor' },
      { command: ['KEYS', '*'], clientName: 'checkout-service' },
    ])).toEqual([{ command: 'KEYS', count: 1 }]);
  });

  it('ignores the analysis MEMORY USAGE calls issued on the monitor client', () => {
    expect(findRestrictedCommands([
      { command: ['MEMORY', 'USAGE', 'user:1', 'SAMPLES', '0'], clientName: 'BetterDB-Monitor' },
    ])).toEqual([]);
  });

  it.each([
    'BetterDB-Monitor',
    'betterdb-monitor-keyscan',
    'BetterDB-Monitor-Node-1a2b3c4d',
    'BetterDB-Agent',
    'BetterDB-Agent-CLI',
    'BetterDB-CLI',
    'BetterDB-Migration-Source',
    'BetterDB-Validation-Source-Cluster',
    'BetterDB-Orders',
    'BetterDB-Monitor-Orders',
    'BetterDB-Monitor-Node-orders1',
  ])('ignores the internal client %s', (clientName) => {
    expect(findRestrictedCommands([{ command: ['KEYS', '*'], clientName }])).toEqual([]);
  });

  it.each(['betterdb', 'BetterDBOrders', 'orders-betterdb-1'])(
    'counts the application client %s',
    (clientName) => {
      expect(findRestrictedCommands([{ command: ['KEYS', '*'], clientName }])).toEqual([{ command: 'KEYS', count: 1 }]);
    },
  );

  it('ignores empty entries', () => {
    expect(findRestrictedCommands([{ command: [] }])).toEqual([]);
  });
});

describe('SERVERLESS_RESTRICTED_COMMANDS', () => {
  it('holds the AWS restricted list', () => {
    expect(SERVERLESS_RESTRICTED_COMMANDS).toHaveLength(60);
    expect(SERVERLESS_RESTRICTED_COMMANDS).toContain('ACL SETUSER');
    expect(SERVERLESS_RESTRICTED_COMMANDS).toContain('WAIT');
  });
});

describe('isElastiCacheServerlessHost', () => {
  it.each([
    'my-cache-abc123.serverless.use1.cache.amazonaws.com',
    'MY-CACHE.SERVERLESS.EUW1.CACHE.AMAZONAWS.COM',
    'my-cache-abc123.serverless.cnn1.cache.amazonaws.com.cn',
    'my-cache-abc123.serverless.use1.cache.amazonaws.com.',
    'my-cache-abc123.serverless.cnn1.cache.amazonaws.com.cn.',
  ])('detects %s', (host) => {
    expect(isElastiCacheServerlessHost(host)).toBe(true);
  });

  it.each([
    'my-cluster.abc123.clustercfg.use1.cache.amazonaws.com',
    'serverless.example.com',
    'my-cache.serverless.use1.cache.amazonaws.com.evil.com',
    'my-cache.serverless.use1.cache.amazonaws.com.cn.evil.com',
    '127.0.0.1',
    '',
  ])('does not detect %s', (host) => {
    expect(isElastiCacheServerlessHost(host)).toBe(false);
  });
});

describe('countSlotOwningMasters', () => {
  const slots = [[0, 100]];

  it('counts masters that own slots and skips replicas', () => {
    expect(countSlotOwningMasters([
      { flags: ['master'], slots },
      { flags: ['myself', 'master'], slots: [[101, 200]] },
      { flags: ['slave'], slots: [] },
    ])).toBe(2);
  });

  it('counts a fail master that still owns slots', () => {
    expect(countSlotOwningMasters([{ flags: ['master', 'fail'], slots }])).toBe(1);
  });

  it('skips a fail master that no longer owns slots', () => {
    expect(countSlotOwningMasters([
      { flags: ['master'], slots },
      { flags: ['master', 'fail'], slots: [] },
    ])).toBe(1);
  });

  it.each(['handshake', 'noaddr'])('skips a %s master without slots', (flag) => {
    expect(countSlotOwningMasters([
      { flags: ['master'], slots },
      { flags: ['master', flag], slots: [] },
    ])).toBe(1);
  });

  it('counts a fail? master that owns slots', () => {
    expect(countSlotOwningMasters([{ flags: ['master', 'fail?'], slots }])).toBe(1);
  });

  it('keeps 166 slot owners under the limit when a failed-over master is still listed', () => {
    const nodes = [
      ...Array.from({ length: 166 }, (_, i) => ({ flags: ['master'], slots: [[i, i]] })),
      { flags: ['master', 'fail'], slots: [] },
    ];
    expect(checkServerlessReadiness(facts({ clusterMasterCount: countSlotOwningMasters(nodes) }))).toEqual([]);
  });

  it('flags 167 slot owners when one of them is a fail master that has not failed over', () => {
    const nodes = [
      ...Array.from({ length: 166 }, (_, i) => ({ flags: ['master'], slots: [[i, i]] })),
      { flags: ['master', 'fail'], slots: [[166, 166]] },
    ];
    const issues = checkServerlessReadiness(facts({ clusterMasterCount: countSlotOwningMasters(nodes) }));
    expect(issues.map(i => i.title)).toEqual(['More than 166 masters']);
  });
});

describe('unread readiness checks', () => {
  it('stays quiet when every probe was read', () => {
    expect(titles(facts())).not.toContain('Some readiness checks could not run');
  });

  it('warns when probe reads failed on some nodes', () => {
    const issue = checkServerlessReadiness(facts({ unreadProbeNodes: 2 }))
      .find(i => i.title === 'Some readiness checks could not run');
    expect(issue?.severity).toBe('warning');
    expect(issue?.detail).toContain('2 nodes');
  });

  it('warns when the command log could not be read', () => {
    const issue = checkServerlessReadiness(facts({ unreadCommandLogNodes: 3 }))
      .find(i => i.title === 'Some readiness checks could not run');
    expect(issue?.severity).toBe('warning');
    expect(issue?.detail).toContain('COMMANDLOG and SLOWLOG could not be read on 3 nodes');
    expect(issue?.detail).not.toContain('INFO stats');
  });

  it('folds probe and command log failures into one warning', () => {
    const issues = checkServerlessReadiness(facts({ unreadProbeNodes: 1, unreadCommandLogNodes: 1 }))
      .filter(i => i.title === 'Some readiness checks could not run');
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('INFO stats');
    expect(issues[0].detail).toContain('COMMANDLOG and SLOWLOG');
  });

  it('uses the singular for one node', () => {
    const issue = checkServerlessReadiness(facts({ unreadProbeNodes: 1 }))
      .find(i => i.title === 'Some readiness checks could not run');
    expect(issue?.detail).toContain('1 node,');
  });
});

describe('summarizeServerlessProbes', () => {
  it('takes the largest per-node script cache instead of the sum', () => {
    const summary = summarizeServerlessProbes([
      { commandInfo: undefined, memory: { number_of_cached_scripts: '5' }, stats: null },
      { commandInfo: undefined, memory: { number_of_cached_scripts: '5' }, stats: null },
      { commandInfo: undefined, memory: { number_of_cached_scripts: '7' }, stats: null },
    ]);
    expect(summary.cachedScripts).toBe(7);
  });

  it('sums pub/sub counts across nodes', () => {
    const summary = summarizeServerlessProbes([
      { commandInfo: undefined, memory: null, stats: { pubsub_channels: '1', pubsub_patterns: '2', pubsubshard_channels: '0' } },
      { commandInfo: undefined, memory: null, stats: { pubsub_channels: '3', pubsub_patterns: '0', pubsubshard_channels: '4' } },
    ]);
    expect(summary.pubsub).toEqual({ channels: 4, patterns: 2, shardChannels: 4 });
  });

  it('collects replication commands missing on any node', () => {
    const summary = summarizeServerlessProbes([
      { commandInfo: [['psync'], ['replconf']], memory: null, stats: null },
      { commandInfo: [null, ['replconf']], memory: null, stats: null },
    ]);
    expect(summary.missingReplicationCommands).toEqual(['PSYNC']);
  });

  it('reports unknown when nothing could be read', () => {
    expect(summarizeServerlessProbes([{ commandInfo: undefined, memory: null, stats: null }])).toEqual({
      missingReplicationCommands: null,
      cachedScripts: null,
      pubsub: null,
      unreadProbeNodes: 1,
    });
  });

  it('counts nodes where any probe read failed', () => {
    const ok = { commandInfo: [['psync'], ['replconf']], memory: { used_memory: '1' }, stats: { pubsub_channels: '0' } };
    const summary = summarizeServerlessProbes([
      ok,
      { ...ok, commandInfo: undefined },
      { ...ok, stats: null },
      { ...ok, memory: null },
    ]);
    expect(summary.unreadProbeNodes).toBe(3);
  });

  it('never reads a failed COMMAND INFO as missing replication commands', () => {
    const summary = summarizeServerlessProbes([
      { commandInfo: undefined, memory: null, stats: null },
      { commandInfo: [['psync'], ['replconf']], memory: null, stats: null },
    ]);
    expect(summary.missingReplicationCommands).toEqual([]);
  });
});

describe('clusterMastersWithOwnSlotMoves', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const seedMasters = [
    { id: A, slots: [[0, 5000]], migratingSlots: [], importingSlots: [] },
    { id: B, slots: [[5001, 10000]], migratingSlots: [], importingSlots: [] },
    { id: C, slots: [[10001, 16383]], migratingSlots: [], importingSlots: [] },
  ];

  function nodesFrom(myself: string, extra = ''): string {
    return [
      `${A} 10.0.0.1:6379@16379 ${myself === A ? 'myself,' : ''}master - 0 0 1 connected 0-5000${myself === A ? extra : ''}`,
      `${B} 10.0.0.2:6379@16379 ${myself === B ? 'myself,' : ''}master - 0 0 2 connected 5001-10000${myself === B ? extra : ''}`,
      `${C} 10.0.0.3:6379@16379 ${myself === C ? 'myself,' : ''}master - 0 0 3 connected 10001-16383${myself === C ? extra : ''}`,
    ].join('\n');
  }

  it('catches a reshard between two masters that only their own myself lines show', () => {
    const masters = clusterMastersWithOwnSlotMoves(seedMasters, [
      nodesFrom(A),
      nodesFrom(B, ` [5001->-${C}]`),
      nodesFrom(C, ` [5001-<-${B}]`),
    ]);
    expect(masters.map(m => [m.migratingSlots, m.importingSlots])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(titles(facts({ clusterMasters: masters, clusterMasterCount: 3 }))).toEqual(['Slot coverage incomplete or changing']);
  });

  it('ignores markers on lines that are not the node itself', () => {
    const masters = clusterMastersWithOwnSlotMoves(seedMasters, [nodesFrom(A).replace('connected 5001-10000', `connected 5001-10000 [5001->-${C}]`)]);
    expect(masters.every(m => m.migratingSlots === 0 && m.importingSlots === 0)).toBe(true);
  });

  it('skips node output that could not be read', () => {
    const masters = clusterMastersWithOwnSlotMoves(seedMasters, [undefined, 42]);
    expect(masters).toHaveLength(3);
    expect(masters[0].slots).toEqual([[0, 5000]]);
  });
});
