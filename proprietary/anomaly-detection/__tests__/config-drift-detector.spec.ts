import {
  ConfigDriftNode,
  DEFAULT_CONFIG_DRIFT_KEYS,
  ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS,
  configDriftSignature,
  detectConfigDrift,
  isEncodingThresholdKey,
} from '../config-drift-detector';

/** Build a minimal ConfigDriftNode for tests. */
function node(
  partial: Partial<ConfigDriftNode> & Pick<ConfigDriftNode, 'connectionId' | 'groupKey' | 'config'>,
): ConfigDriftNode {
  return { ...partial };
}

describe('detectConfigDrift', () => {
  it('flags two same-group nodes that disagree on maxmemory', () => {
    const nodes = [
      node({
        connectionId: 'c1',
        name: 'primary',
        groupKey: 'replid:aaaa',
        config: { maxmemory: '1000000' },
      }),
      node({
        connectionId: 'c2',
        name: 'replica-1',
        groupKey: 'replid:aaaa',
        config: { maxmemory: '2000000' },
      }),
    ];

    const drifts = detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].key).toBe('maxmemory');
    expect(drifts[0].groupKey).toBe('replid:aaaa');
    expect(drifts[0].values).toEqual(
      expect.arrayContaining([
        { connectionId: 'c1', name: 'primary', value: '1000000' },
        { connectionId: 'c2', name: 'replica-1', value: '2000000' },
      ]),
    );
  });

  it('flags only the single key that drifts among three same-group nodes', () => {
    const nodes = [
      node({
        connectionId: 'c1',
        groupKey: 'replid:bbbb',
        config: { maxmemory: '1000000', 'maxmemory-policy': 'allkeys-lru', appendonly: 'yes' },
      }),
      node({
        connectionId: 'c2',
        groupKey: 'replid:bbbb',
        config: { maxmemory: '1000000', 'maxmemory-policy': 'noeviction', appendonly: 'yes' },
      }),
      node({
        connectionId: 'c3',
        groupKey: 'replid:bbbb',
        config: { maxmemory: '1000000', 'maxmemory-policy': 'allkeys-lru', appendonly: 'yes' },
      }),
    ];

    const drifts = detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].key).toBe('maxmemory-policy');
    expect(drifts[0].values.map((v) => v.connectionId).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('reports nothing when all nodes in a group agree', () => {
    const nodes = [
      node({
        connectionId: 'c1',
        groupKey: 'replid:cccc',
        config: { maxmemory: '1000000', appendonly: 'yes' },
      }),
      node({
        connectionId: 'c2',
        groupKey: 'replid:cccc',
        config: { maxmemory: '1000000', appendonly: 'yes' },
      }),
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });

  it('never compares nodes across different groups, even with different values', () => {
    const nodes = [
      node({ connectionId: 'c1', groupKey: 'replid:group-a', config: { maxmemory: '1000000' } }),
      node({ connectionId: 'c2', groupKey: 'replid:group-b', config: { maxmemory: '9999999' } }),
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });

  it('reports nothing when only a single node of a group is monitored', () => {
    const nodes = [
      node({ connectionId: 'c1', groupKey: 'replid:lonely', config: { maxmemory: '1000000' } }),
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });

  it('ignores nodes with no groupKey', () => {
    const nodes = [
      node({ connectionId: 'c1', groupKey: '', config: { maxmemory: '1000000' } }),
      node({ connectionId: 'c2', groupKey: '', config: { maxmemory: '2000000' } }),
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });

  it('only compares keys on the allowlist, ignoring node-specific keys present in config', () => {
    const nodes = [
      node({
        connectionId: 'c1',
        groupKey: 'replid:dddd',
        config: { maxmemory: '1000000', bind: '10.0.0.1', port: '6379', dir: '/data/node1' },
      }),
      node({
        connectionId: 'c2',
        groupKey: 'replid:dddd',
        config: { maxmemory: '1000000', bind: '10.0.0.2', port: '6380', dir: '/data/node2' },
      }),
    ];

    // bind/port/dir legitimately differ per node and are NOT in the allowlist.
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
    // Sanity: if the caller passed those keys explicitly, they WOULD be flagged —
    // proving the allowlist filtering happens via the `keys` param, not magic.
    expect(detectConfigDrift(nodes, ['bind'])).toHaveLength(1);
  });

  it('excludes a node from a key comparison when it never reported that key, without treating the gap as a distinct value', () => {
    const nodes = [
      node({ connectionId: 'c1', groupKey: 'replid:eeee', config: { maxmemory: '1000000' } }),
      // c2 never reported maxmemory-clients (e.g. unsupported on its version) —
      // must not be treated as an implicit third/distinct value.
      node({ connectionId: 'c2', groupKey: 'replid:eeee', config: { maxmemory: '1000000' } }),
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });

  it('does not compare a key that only one node in the group reported', () => {
    const nodes = [
      node({
        connectionId: 'c1',
        groupKey: 'replid:ffff',
        config: { maxmemory: '1000000', timeout: '0' },
      }),
      node({ connectionId: 'c2', groupKey: 'replid:ffff', config: { maxmemory: '1000000' } }), // no 'timeout'
    ];
    expect(detectConfigDrift(nodes, DEFAULT_CONFIG_DRIFT_KEYS)).toHaveLength(0);
  });
});

describe('configDriftSignature', () => {
  function makeDrift(values: Array<{ connectionId: string; value: string }>) {
    return detectConfigDrift(
      values.map((v) =>
        node({
          connectionId: v.connectionId,
          groupKey: 'replid:sig',
          config: { maxmemory: v.value },
        }),
      ),
      ['maxmemory'],
    )[0];
  }

  it('is stable across different orderings of the same drifting values', () => {
    const a = makeDrift([
      { connectionId: 'c1', value: '100' },
      { connectionId: 'c2', value: '200' },
    ]);
    const b = makeDrift([
      { connectionId: 'c2', value: '200' },
      { connectionId: 'c1', value: '100' },
    ]);
    expect(configDriftSignature(a)).toBe(configDriftSignature(b));
  });

  it('changes when a node value changes', () => {
    const before = makeDrift([
      { connectionId: 'c1', value: '100' },
      { connectionId: 'c2', value: '200' },
    ]);
    const after = makeDrift([
      { connectionId: 'c1', value: '100' },
      { connectionId: 'c2', value: '300' },
    ]);
    expect(configDriftSignature(before)).not.toBe(configDriftSignature(after));
  });

  it('changes when the drifting group changes even for the same key/values pattern', () => {
    const groupA = detectConfigDrift(
      [
        node({ connectionId: 'c1', groupKey: 'replid:group-a', config: { maxmemory: '100' } }),
        node({ connectionId: 'c2', groupKey: 'replid:group-a', config: { maxmemory: '200' } }),
      ],
      ['maxmemory'],
    )[0];
    const groupB = detectConfigDrift(
      [
        node({ connectionId: 'c1', groupKey: 'replid:group-b', config: { maxmemory: '100' } }),
        node({ connectionId: 'c2', groupKey: 'replid:group-b', config: { maxmemory: '200' } }),
      ],
      ['maxmemory'],
    )[0];
    expect(configDriftSignature(groupA)).not.toBe(configDriftSignature(groupB));
  });
});

describe('encoding-threshold drift (valkey#3479)', () => {
  function shard(configs: Array<Record<string, string>>): ConfigDriftNode[] {
    return configs.map((config, i) => {
      return {
        connectionId: `c${i + 1}`,
        name: i === 0 ? 'primary' : `replica-${i}`,
        groupKey: 'replid:shard-a',
        config,
      };
    });
  }

  it('flags a shard whose nodes disagree on hash-max-listpack-entries', () => {
    const nodes = shard([
      { 'hash-max-listpack-entries': '128', 'hash-max-listpack-value': '64' },
      { 'hash-max-listpack-entries': '512', 'hash-max-listpack-value': '64' },
    ]);
    const drifts = detectConfigDrift(nodes, ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].key).toBe('hash-max-listpack-entries');
    expect(drifts[0].values.map((v) => v.value).sort()).toEqual(['128', '512']);
  });

  it('stays silent when encoding thresholds match across the shard', () => {
    const config = {
      'hash-max-listpack-entries': '128',
      'list-max-listpack-size': '128',
      'set-max-intset-entries': '512',
      'zset-max-listpack-entries': '128',
    };
    const drifts = detectConfigDrift(
      shard([{ ...config }, { ...config }, { ...config }]),
      ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS,
    );
    expect(drifts).toEqual([]);
  });

  it('excludes a node that did not report a key instead of treating it as drifted', () => {
    // c3 failed its CONFIG GET for the zset key (older version / transient
    // error): the two nodes that DID report it agree, so no drift.
    const drifts = detectConfigDrift(
      shard([{ 'zset-max-listpack-entries': '128' }, { 'zset-max-listpack-entries': '128' }, {}]),
      ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS,
    );
    expect(drifts).toEqual([]);
  });

  it('classifies every encoding-threshold key for the re-encoding rationale', () => {
    for (const key of ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS) {
      expect(isEncodingThresholdKey(key)).toBe(true);
    }
    for (const key of DEFAULT_CONFIG_DRIFT_KEYS) {
      expect(isEncodingThresholdKey(key)).toBe(false);
    }
  });

  it('covers all four collection types whose encodings the thresholds control', () => {
    const covered = new Set(
      ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS.map((key) => {
        return key.split('-')[0];
      }),
    );
    expect(Array.from(covered).sort()).toEqual(['hash', 'list', 'set', 'zset']);
  });
});
