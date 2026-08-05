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

  // Core valkey#304 symptom: CLUSTER NODES and CLUSTER SHARDS disagree about
  // the same node's hostname/endpoint.
  it('flags a node whose CLUSTER NODES hostname disagrees with its CLUSTER SHARDS endpoint', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [
      shard([{ id: 'a', role: 'master', endpoint: 'stale-node-a.example.com' }]),
    ];

    const findings = detectHostnameStaleness(nodes, shards);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      nodeId: 'a',
      reason: 'endpoint_mismatch',
      nodesHostname: 'node-a.example.com',
      shardsEndpoint: 'stale-node-a.example.com',
    });
  });

  it('flags a hostname-less node whose CLUSTER SHARDS endpoint disagrees with its raw IP', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379' }),
    ];
    const shards = [shard([{ id: 'a', role: 'master', endpoint: '10.0.0.99' }])];

    const findings = detectHostnameStaleness(nodes, shards);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      nodeId: 'a',
      reason: 'endpoint_mismatch',
      nodesHostname: undefined,
      shardsEndpoint: '10.0.0.99',
    });
  });

  it('does not flag a mismatch when CLUSTER SHARDS endpoint matches the hostname-less node’s IP', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379' }),
    ];
    const shards = [shard([{ id: 'a', role: 'master', endpoint: '10.0.0.1' }])];

    expect(detectHostnameStaleness(nodes, shards)).toEqual([]);
  });

  it('does not flag a mismatch when CLUSTER SHARDS endpoint matches the announced hostname', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        hostname: 'node-a.example.com',
      }),
    ];
    const shards = [shard([{ id: 'a', role: 'master', endpoint: 'node-a.example.com' }])];

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
      shard([{ id: 'a', role: 'master', endpoint: 'node-a.example.com' }]),
      shard([{ id: 'ghost', role: 'master', endpoint: 'ghost.example.com' }]),
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

  it('can report both reasons for the same node independently', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], hostname: 'node-a.example.com' }),
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379' }), // missing hostname
    ];
    const shards = [
      shard([
        { id: 'a', role: 'master', endpoint: 'node-a.example.com' },
        { id: 'b', role: 'master', endpoint: '10.0.0.99' }, // disagrees with b's raw IP too
      ]),
    ];

    const findings = detectHostnameStaleness(nodes, shards);
    expect(findings).toHaveLength(2);
    const reasons = findings.map((f) => f.reason).sort();
    expect(reasons).toEqual(['endpoint_mismatch', 'missing_hostname']);
    expect(findings.every((f) => f.nodeId === 'b')).toBe(true);
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
    const mismatch: HostnameStaleness = { nodeId: 'a', address: '', reason: 'endpoint_mismatch' };
    expect(hostnameStalenessSignature(missing)).not.toBe(hostnameStalenessSignature(mismatch));
  });
});
