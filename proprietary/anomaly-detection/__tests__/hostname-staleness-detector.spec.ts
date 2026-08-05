import { ClusterNode, ClusterShard } from '@app/common/types/metrics.types';
import {
  detectHostnameStaleness,
  hostnameStalenessSignature,
  HostnameStaleness,
} from '../hostname-staleness-detector';

/** Build a minimal ClusterNode for tests. */
function node(
  partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'flags'>,
): ClusterNode {
  return {
    address: '127.0.0.1:6379@16379',
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots: [],
    ...partial,
  };
}

/** Build a minimal ClusterShard for tests. */
function shard(nodes: ClusterShard['nodes']): ClusterShard {
  return { slots: [[0, 16383]], nodes };
}

describe('detectHostnameStaleness', () => {
  it('returns nothing for a healthy cluster where every node has a hostname', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'b', flags: ['master'], hostname: 'node-b.example.com' }),
      node({ id: 'c', flags: ['slave'], master: 'a', hostname: 'node-c.example.com' }),
    ];
    expect(detectHostnameStaleness(nodes)).toEqual([]);
  });

  it('returns nothing when hostnames are simply not in use (every node lacks one)', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'] }),
      node({ id: 'b', flags: ['master'] }),
      node({ id: 'c', flags: ['slave'], master: 'a' }),
    ];
    expect(detectHostnameStaleness(nodes)).toEqual([]);
  });

  it('returns nothing for an empty view', () => {
    expect(detectHostnameStaleness([])).toEqual([]);
  });

  // Core valkey#304 symptom: a node has just joined/restarted and hostname
  // gossip hasn't converged for it yet, while its peers already carry one.
  it('flags a node missing a hostname while its peers have one', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'b', flags: ['master'] }), // just joined, no hostname yet
      node({ id: 'c', flags: ['master'], hostname: 'node-c.example.com' }),
    ];

    const findings = detectHostnameStaleness(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      nodeId: 'b',
      reason: 'missing_hostname',
    });
  });

  it('flags every node missing a hostname when multiple are affected', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'b', flags: ['master'] }),
      node({ id: 'c', flags: ['master'] }),
    ];

    const findings = detectHostnameStaleness(nodes);
    expect(findings.map((f) => f.nodeId).sort()).toEqual(['b', 'c']);
    expect(findings.every((f) => f.reason === 'missing_hostname')).toBe(true);
  });

  it('does not flag handshake/noaddr nodes as missing a hostname', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'b', flags: ['master', 'handshake'] }),
      node({ id: 'c', flags: ['master', 'noaddr'] }),
    ];
    expect(detectHostnameStaleness(nodes)).toEqual([]);
  });

  it('does not flag a dead (fail) node that lacks a hostname — it cannot self-heal', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'dead', flags: ['master', 'fail'] }), // hostname-less but dead → not serving traffic
    ];
    expect(detectHostnameStaleness(nodes)).toEqual([]);
  });

  it('a dead (fail?) node that kept a hostname does not make the cluster look hostname-enabled', () => {
    // Only the dead node has a hostname; the two live nodes have none. A dead
    // node must not make every live node get flagged as missing a hostname.
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'] }),
      node({ id: 'b', flags: ['master'] }),
      node({ id: 'dead', flags: ['master', 'fail?'], hostname: 'gone.example.com' }),
    ];
    expect(detectHostnameStaleness(nodes)).toEqual([]);
  });

  // Core valkey#304 symptom: CLUSTER NODES and CLUSTER SHARDS both carry a
  // hostname for the same node but they DISAGREE.
  it('flags a node whose CLUSTER NODES hostname disagrees with its CLUSTER SHARDS hostname', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [
      shard([{ id: 'a', role: 'master', hostname: 'stale-node-a.example.com' }]),
    ];

    const findings = detectHostnameStaleness(nodes, shards);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      nodeId: 'a',
      reason: 'hostname_mismatch',
      nodesHostname: 'node-a.example.com',
      shardsHostname: 'stale-node-a.example.com',
    });
  });

  // Bugbot regression guard: CLUSTER SHARDS `endpoint` follows
  // cluster-preferred-endpoint-type (default `ip`), so a healthy hostname
  // cluster has NODES.hostname set while SHARDS.endpoint is the raw IP. The old
  // hostname-vs-endpoint compare false-fired here; the hostname-vs-hostname
  // compare (SHARDS hostname agrees) must stay silent.
  it('does not flag when CLUSTER SHARDS endpoint is the raw IP but its hostname agrees', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [
      shard([
        { id: 'a', role: 'master', endpoint: '10.0.0.1', hostname: 'node-a.example.com' },
      ]),
    ];

    expect(detectHostnameStaleness(nodes, shards)).toEqual([]);
  });

  it('does not flag a hostname mismatch when CLUSTER SHARDS carries no hostname (one side omits it)', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    // SHARDS only has an endpoint (the IP), no announced hostname → convergence
    // lag, not a hard mismatch.
    const shards = [shard([{ id: 'a', role: 'master', endpoint: '10.0.0.1' }])];

    expect(detectHostnameStaleness(nodes, shards)).toEqual([]);
  });

  it('does not flag when both views carry the same hostname', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [
      shard([{ id: 'a', role: 'master', hostname: 'node-a.example.com' }]),
    ];

    expect(detectHostnameStaleness(nodes, shards)).toEqual([]);
  });

  it('ignores CLUSTER SHARDS entries for node ids absent from CLUSTER NODES', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [
      shard([{ id: 'a', role: 'master', hostname: 'node-a.example.com' }]),
      shard([{ id: 'ghost', role: 'master', hostname: 'ghost.example.com' }]),
    ];

    expect(detectHostnameStaleness(nodes, shards)).toEqual([]);
  });

  it('skips the CLUSTER SHARDS comparison when a node is absent from the shards view', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    // CLUSTER SHARDS unavailable / doesn't yet know about this node.
    expect(detectHostnameStaleness(nodes, [])).toEqual([]);
    expect(detectHostnameStaleness(nodes, undefined)).toEqual([]);
  });

  it('can report both reasons across nodes in one view', () => {
    const nodes = [
      // Node a carries a hostname that disagrees with CLUSTER SHARDS.
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      // Node b has no hostname while its peer does.
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379' }),
    ];
    const shards = [
      shard([
        { id: 'a', role: 'master', hostname: 'stale-node-a.example.com' },
        { id: 'b', role: 'master', endpoint: '10.0.0.2' }, // no announced hostname
      ]),
    ];

    const findings = detectHostnameStaleness(nodes, shards);
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.nodeId === 'a')?.reason).toBe('hostname_mismatch');
    expect(findings.find((f) => f.nodeId === 'b')?.reason).toBe('missing_hostname');
  });
});

describe('hostnameStalenessSignature', () => {
  it('is stable for the same finding', () => {
    const finding: HostnameStaleness = {
      nodeId: 'a',
      address: '10.0.0.1:6379@16379',
      reason: 'missing_hostname',
    };
    expect(hostnameStalenessSignature(finding)).toBe(hostnameStalenessSignature({ ...finding }));
  });

  it('differs by node id', () => {
    const a: HostnameStaleness = { nodeId: 'a', address: '', reason: 'missing_hostname' };
    const b: HostnameStaleness = { nodeId: 'b', address: '', reason: 'missing_hostname' };
    expect(hostnameStalenessSignature(a)).not.toBe(hostnameStalenessSignature(b));
  });

  it('differs by reason for the same node, so both can be tracked independently', () => {
    const missing: HostnameStaleness = { nodeId: 'a', address: '', reason: 'missing_hostname' };
    const mismatch: HostnameStaleness = { nodeId: 'a', address: '', reason: 'hostname_mismatch' };
    expect(hostnameStalenessSignature(missing)).not.toBe(hostnameStalenessSignature(mismatch));
  });
});
