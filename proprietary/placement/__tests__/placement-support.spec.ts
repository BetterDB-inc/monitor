import {
  isAclRefusal,
  judgePlacementSupport,
  judgeUnconnectedPlacement,
  managedPlacementProvider,
  migrateSlotsListed,
  type PlacementSupportFacts,
} from '../placement-support';

const valkey9 = { dbType: 'valkey' as const, version: '9.0.1' };

function facts(overrides: Partial<PlacementSupportFacts> = {}): PlacementSupportFacts {
  return {
    clusterEnabled: true,
    managedProvider: null,
    clusterWideView: true,
    slotStats: true,
    dialsDataNodes: true,
    primaries: [
      { address: '10.0.0.1:7001', server: valkey9, migrateSlotsCommand: true },
      { address: '10.0.0.2:7002', server: valkey9, migrateSlotsCommand: true },
    ],
    aclDenied: false,
    slotMigrationFlag: true,
    memoryStorage: false,
    signIn: true,
    ...overrides,
  };
}

const blockedBy = (f: PlacementSupportFacts) => {
  const verdict = judgePlacementSupport(f);
  return Object.fromEntries(
    Object.entries(verdict.modes).map(([mode, state]) => [mode, state.blockedBy]),
  );
};

describe('judgePlacementSupport', () => {
  it('supports every mode on a self-hosted Valkey 9 cluster', () => {
    const verdict = judgePlacementSupport(facts());
    expect(verdict.issues).toEqual([]);
    expect(Object.values(verdict.modes).every((mode) => mode.available)).toBe(true);
  });

  it('keeps Observe available whatever the reason', () => {
    const verdict = judgePlacementSupport(facts({ clusterEnabled: false }));
    expect(verdict.modes.observe).toEqual({ available: true, blockedBy: null });
  });

  it('limits a standalone server to Observe and reports only not_cluster', () => {
    const verdict = judgePlacementSupport(facts({ clusterEnabled: false, primaries: null }));
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['not_cluster']);
    expect(blockedBy(facts({ clusterEnabled: false, primaries: null }))).toEqual({
      observe: null,
      recommend: 'not_cluster',
      approve: 'not_cluster',
      auto: 'not_cluster',
    });
  });

  it.each([
    ['per_node_connections', { clusterWideView: false }],
    ['slot_stats_off', { slotStats: false }],
    ['not_dialed', { dialsDataNodes: false, primaries: null }],
  ] as const)('limits %s to Observe', (reason, overrides) => {
    expect(blockedBy(facts(overrides))).toEqual({
      observe: null,
      recommend: reason,
      approve: reason,
      auto: reason,
    });
  });

  it('keeps Recommend for a managed provider and names it', () => {
    const verdict = judgePlacementSupport(facts({ managedProvider: 'AWS ElastiCache' }));
    expect(verdict.issues[0]).toMatchObject({ reason: 'provider_managed', provider: 'AWS ElastiCache' });
    expect(verdict.issues[0].detail).toContain('Managed by AWS ElastiCache');
    expect(blockedBy(facts({ managedProvider: 'AWS ElastiCache' }))).toEqual({
      observe: null,
      recommend: null,
      approve: 'provider_managed',
      auto: 'provider_managed',
    });
  });

  it('marks a Valkey primary before 9.0 as server_version, naming the node', () => {
    const verdict = judgePlacementSupport(
      facts({
        primaries: [
          { address: '10.0.0.1:7001', server: valkey9, migrateSlotsCommand: true },
          { address: '10.0.0.2:7002', server: { dbType: 'valkey', version: '8.1.4' }, migrateSlotsCommand: false },
        ],
      }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['server_version']);
    expect(verdict.issues[0].detail).toContain('10.0.0.2:7002');
    expect(verdict.modes.recommend.available).toBe(true);
    expect(verdict.modes.approve.blockedBy).toBe('server_version');
  });

  it('marks Redis 8.4+ as copy_only', () => {
    const redis = { dbType: 'redis' as const, version: '8.4.0' };
    const verdict = judgePlacementSupport(
      facts({
        primaries: [
          { address: 'a:1', server: redis, migrateSlotsCommand: false },
          { address: 'b:2', server: redis, migrateSlotsCommand: false },
        ],
      }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['copy_only']);
    expect(verdict.modes.approve.blockedBy).toBe('copy_only');
  });

  it('marks Redis before 8.4 as server_version', () => {
    const redis = { dbType: 'redis' as const, version: '7.2.4' };
    const verdict = judgePlacementSupport(
      facts({ primaries: [{ address: 'a:1', server: redis, migrateSlotsCommand: false }] }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['server_version']);
  });

  it('names only the primaries that block in a mixed Valkey and Redis cluster', () => {
    const verdict = judgePlacementSupport(
      facts({
        primaries: [
          { address: 'a:1', server: valkey9, migrateSlotsCommand: true },
          {
            address: 'b:1',
            server: { dbType: 'redis', version: '7.4.0' },
            migrateSlotsCommand: false,
          },
          {
            address: 'c:1',
            server: { dbType: 'redis', version: '8.4.0' },
            migrateSlotsCommand: true,
          },
        ],
      }),
    );
    expect(verdict.issues[0]).toEqual({
      reason: 'server_version',
      detail:
        'Slot moves need Valkey 9.0 or later on every primary: b:1 runs redis 7.4.0, c:1 runs redis 8.4.0.',
    });
  });

  it('treats a primary whose version could not be read as blocked', () => {
    const verdict = judgePlacementSupport(
      facts({ primaries: [{ address: 'a:1', server: null, migrateSlotsCommand: null }] }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['server_version']);
    expect(verdict.issues[0].detail).toContain('a:1');
  });

  it('treats a cluster whose primaries could not be listed as blocked for Approve', () => {
    const verdict = judgePlacementSupport(facts({ primaries: null }));
    expect(verdict.modes.recommend.available).toBe(true);
    expect(verdict.modes.approve.blockedBy).toBe('server_version');
  });

  it('marks a renamed or disabled MIGRATESLOTS as command_unavailable', () => {
    const verdict = judgePlacementSupport(
      facts({
        primaries: [
          { address: 'a:1', server: valkey9, migrateSlotsCommand: true },
          { address: 'b:2', server: valkey9, migrateSlotsCommand: false },
        ],
      }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['command_unavailable']);
    expect(verdict.issues[0].detail).toContain('b:2');
  });

  it('treats an unread COMMAND INFO as command_unavailable', () => {
    const verdict = judgePlacementSupport(
      facts({ primaries: [{ address: 'a:1', server: valkey9, migrateSlotsCommand: null }] }),
    );
    expect(verdict.issues.map((issue) => issue.reason)).toEqual(['command_unavailable']);
  });

  it('blocks Approve and Auto on acl and on the slot migration flag', () => {
    expect(blockedBy(facts({ aclDenied: true }))).toMatchObject({ recommend: null, approve: 'acl', auto: 'acl' });
    expect(blockedBy(facts({ slotMigrationFlag: false }))).toMatchObject({
      recommend: null,
      approve: 'flag_off',
      auto: 'flag_off',
    });
  });

  it('gates memory storage on Approve and Auto only', () => {
    expect(blockedBy(facts({ memoryStorage: true }))).toEqual({
      observe: null,
      recommend: null,
      approve: 'memory_storage',
      auto: 'memory_storage',
    });
  });

  it('gates no sign-in on Auto only', () => {
    expect(blockedBy(facts({ signIn: false }))).toEqual({
      observe: null,
      recommend: null,
      approve: null,
      auto: 'no_sign_in',
    });
  });

  it('lists every failing reason in order and picks the first that blocks each mode', () => {
    const f = facts({
      managedProvider: 'Redis Cloud',
      slotStats: false,
      memoryStorage: true,
      signIn: false,
      slotMigrationFlag: false,
    });
    const verdict = judgePlacementSupport(f);
    expect(verdict.issues.map((issue) => issue.reason)).toEqual([
      'provider_managed',
      'slot_stats_off',
      'flag_off',
      'memory_storage',
      'no_sign_in',
    ]);
    expect(blockedBy(f)).toEqual({
      observe: null,
      recommend: 'slot_stats_off',
      approve: 'provider_managed',
      auto: 'provider_managed',
    });
  });
});

describe('managedPlacementProvider', () => {
  const env = process.env.MONITOR_PROVIDER_OVERRIDE;
  afterEach(() => {
    if (env === undefined) delete process.env.MONITOR_PROVIDER_OVERRIDE;
    else process.env.MONITOR_PROVIDER_OVERRIDE = env;
  });

  it.each([
    ['clustercfg.prod.abc123.use1.cache.amazonaws.com', 'AWS ElastiCache'],
    ['10.1.2.3.internal.memorystore.googleapis.com', 'Google Memorystore'],
    ['redis-123.c1.us-east-1-2.ec2.redis-cloud.com', 'Redis Cloud'],
    ['eu1-fine-cat-123.upstash.io', 'Upstash'],
    ['myname.redis.cache.windows.net', 'Azure Cache for Redis'],
    ['valkey-abc.aivencloud.com', 'Aiven'],
  ])('names the provider of %s', (host, name) => {
    delete process.env.MONITOR_PROVIDER_OVERRIDE;
    expect(managedPlacementProvider(host, undefined)).toBe(name);
  });

  it('names Redis Cloud from a redislabs build id', () => {
    delete process.env.MONITOR_PROVIDER_OVERRIDE;
    expect(managedPlacementProvider('10.0.0.1', { redis_build_id: 'redislabs-abc' })).toBe('Redis Cloud');
  });

  it('does not take Amazon Linux for ElastiCache', () => {
    delete process.env.MONITOR_PROVIDER_OVERRIDE;
    expect(managedPlacementProvider('10.0.0.1', { os: 'Linux 5.10 amzn2 Amazon Linux' })).toBeNull();
  });

  it('honours an override naming a managed provider', () => {
    process.env.MONITOR_PROVIDER_OVERRIDE = 'elasticache';
    expect(managedPlacementProvider('10.0.0.1', undefined)).toBe('AWS ElastiCache');
  });

  it('ignores a self-hosted override', () => {
    process.env.MONITOR_PROVIDER_OVERRIDE = 'self-hosted';
    expect(managedPlacementProvider('10.0.0.1', undefined)).toBeNull();
  });

  it.each([
    ['clustercfg.prod.abc123.use1.cache.amazonaws.com', undefined],
    ['myname.redis.cache.windows.net', undefined],
    ['10.0.0.1', { redis_build_id: 'redislabs-abc' }],
  ])('takes a self-hosted override over what %s looks like', (host, server) => {
    process.env.MONITOR_PROVIDER_OVERRIDE = 'self-hosted';
    expect(managedPlacementProvider(host, server)).toBeNull();
  });

  it('takes an override naming a provider over the host', () => {
    process.env.MONITOR_PROVIDER_OVERRIDE = 'upstash';
    expect(managedPlacementProvider('myname.redis.cache.windows.net', undefined)).toBe('Upstash');
  });
});

describe('migrateSlotsListed', () => {
  it('finds the subcommand in a COMMAND INFO reply', () => {
    expect(migrateSlotsListed([['cluster|migrateslots', -4, ['admin'], 0, 0, 0]])).toBe(true);
  });

  it.each([[[null]], [[]], [null], ['ERR unknown']])('treats %j as missing', (reply) => {
    expect(migrateSlotsListed(reply)).toBe(false);
  });
});

describe('isAclRefusal', () => {
  it('takes a NOPERM reply as an acl refusal', () => {
    expect(
      isAclRefusal(
        'NOPERM User monitor has no permissions to run the cluster|migrateslots command',
      ),
    ).toBe(true);
    expect(isAclRefusal("ERR I don't know about node b0000000")).toBe(false);
  });
});

describe('judgeUnconnectedPlacement', () => {
  it('keeps a cluster the monitor has not connected to on Observe', () => {
    const verdict = judgeUnconnectedPlacement();
    expect(verdict.issues).toEqual([
      { reason: 'not_connected', detail: 'The monitor has not connected to this cluster yet.' },
    ]);
    expect(verdict.modes.observe).toEqual({ available: true, blockedBy: null });
    expect(verdict.modes.recommend).toEqual({ available: false, blockedBy: 'not_connected' });
  });
});
