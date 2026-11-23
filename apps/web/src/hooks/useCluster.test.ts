import { describe, it, expect } from 'vitest';
import { classifyClusterNodes } from './useCluster';
import type { ClusterNode } from '../types/metrics';

function makeNode(
  id: string,
  flags: string[],
  slots: number[][] = [],
  patch: Partial<ClusterNode> = {},
): ClusterNode {
  return {
    id,
    address: `10.0.0.1:6379`,
    flags,
    master: flags.includes('master') ? '-' : 'p0',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots,
    ...patch,
  };
}

describe('classifyClusterNodes', () => {
  it('splits slot-owning primaries, empty primaries, and replicas', () => {
    const nodes: ClusterNode[] = [
      ...Array.from({ length: 12 }, (_, i) => makeNode(`p${i}`, ['master'], [[i * 100, i * 100 + 99]])),
      makeNode('ghost', ['master'], []),
      ...Array.from({ length: 23 }, (_, i) => makeNode(`r${i}`, ['slave'], [])),
    ];

    const result = classifyClusterNodes(nodes);
    expect(result.primaries).toHaveLength(12);
    expect(result.emptyPrimaries).toHaveLength(1);
    expect(result.emptyPrimaries[0].id).toBe('ghost');
    expect(result.replicas).toHaveLength(23);
  });

  it('puts fail, fail?, and noaddr masters into failedPrimaries regardless of slots', () => {
    const nodes: ClusterNode[] = [
      makeNode('p1', ['master'], [[0, 100]]),
      makeNode('p2', ['master', 'fail'], [[101, 200]]),
      makeNode('p3', ['master', 'noaddr'], [[201, 300]]),
      makeNode('p4', ['master', 'fail?'], [[301, 400]]),
      makeNode('p5', ['master', 'fail'], []),
    ];

    const result = classifyClusterNodes(nodes);
    expect(result.primaries.map((n) => n.id)).toEqual(['p1']);
    expect(result.emptyPrimaries).toEqual([]);
    expect(result.failedPrimaries.map((n) => n.id)).toEqual(['p2', 'p3', 'p4', 'p5']);
  });

  it('excludes slotless masters with migrating or importing slots from emptyPrimaries', () => {
    const nodes: ClusterNode[] = [
      makeNode('p1', ['master'], [], { importingSlots: [{ slot: 5, sourceNodeId: 'p0' }] }),
      makeNode('p2', ['master'], [], { migratingSlots: [{ slot: 6, targetNodeId: 'p0' }] }),
      makeNode('p3', ['master'], []),
    ];

    const result = classifyClusterNodes(nodes);
    expect(result.primaries.map((n) => n.id)).toEqual(['p1', 'p2']);
    expect(result.emptyPrimaries.map((n) => n.id)).toEqual(['p3']);
  });
});
