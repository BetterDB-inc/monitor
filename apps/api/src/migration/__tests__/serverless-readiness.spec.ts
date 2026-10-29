import {
  checkServerlessReadiness,
  countSlotOwningMasters,
  findRestrictedCommands,
  isElastiCacheServerlessHost,
  SERVERLESS_RESTRICTED_COMMANDS,
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
    missingReplicationCommands: [],
    clusterMasters: fullCoverage(),
    cachedScripts: 0,
    pubsub: { channels: 0, patterns: 0, shardChannels: 0 },
    commandEntries: [],
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

  describe('memory per master', () => {
    it('stays quiet at exactly 32 GB on a master', () => {
      expect(checkServerlessReadiness(facts({ masterUsedMemory: [32 * GIB, 1 * GIB] }))).toEqual([]);
    });

    it('blocks when a master holds more than 32 GB', () => {
      const issues = checkServerlessReadiness(facts({ masterUsedMemory: [32 * GIB + 1, 1 * GIB] }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
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
      expect(issues[0].title).toMatch(/5,000 GiB/);
    });
  });

  describe('master count', () => {
    it('stays quiet at 166 masters', () => {
      expect(titles(facts({ clusterMasterCount: 166 }))).toEqual([]);
    });

    it('blocks at 167 masters', () => {
      const issues = checkServerlessReadiness(facts({ clusterMasterCount: 167 }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocking');
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
      expect(issues[0].severity).toBe('blocking');
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
      expect(issues[0].severity).toBe('blocking');
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
      [{ channels: 0, patterns: 1, shardChannels: 0 }],
      [{ channels: 0, patterns: 0, shardChannels: 1 }],
    ])('warns when subscribers are present (%o)', (pubsub) => {
      const issues = checkServerlessReadiness(facts({ pubsub }));
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('warning');
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

  it.each([
    'BetterDB-Monitor',
    'betterdb-monitor-keyscan',
    'BetterDB-Monitor-Node-1a2b3c4d',
    'BetterDB-Agent',
    'BetterDB-Agent-CLI',
    'BetterDB-CLI',
    'BetterDB-Migration-Source',
    'BetterDB-Validation-Source-Cluster',
  ])('ignores the internal client %s', (clientName) => {
    expect(findRestrictedCommands([{ command: ['KEYS', '*'], clientName }])).toEqual([]);
  });

  it.each(['BetterDB-Orders', 'BetterDB-Monitor-Orders', 'BetterDB-Monitor-Node-orders1', 'betterdb'])(
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
  ])('detects %s', (host) => {
    expect(isElastiCacheServerlessHost(host)).toBe(true);
  });

  it.each([
    'my-cluster.abc123.clustercfg.use1.cache.amazonaws.com',
    'serverless.example.com',
    'my-cache.serverless.use1.cache.amazonaws.com.evil.com',
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
