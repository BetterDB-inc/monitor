import type { ClusterNode } from '@app/common/types/metrics.types';
import { type ObserverSelectionInput, selectObservers } from '../topology-observers';

function node(id: string, zone?: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id,
    address: `${id}.internal:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...(zone ? { availabilityZone: zone } : {}),
    ...patch,
  };
}

function replicaOf(master: string, id: string, zone?: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return node(id, zone, { flags: ['slave'], master, ...patch });
}

function select(nodes: ClusterNode[], patch: Partial<ObserverSelectionInput> = {}) {
  return selectObservers({
    nodes,
    anchorId: nodes[0].id,
    registeredIds: new Set(),
    previous: [],
    unanswered: new Set(),
    frozen: new Set(),
    accused: [],
    nodesPerZone: 1,
    randomNodes: 3,
    maxObservers: 12,
    maxAccused: 2,
    random: () => 0,
    ...patch,
  });
}

const THREE_ZONES = [
  node('a1', 'a'),
  node('a2', 'a'),
  node('b1', 'b'),
  node('b2', 'b'),
  node('c1', 'c'),
  node('c2', 'c'),
];

describe('selectObservers', () => {
  it('takes one node per zone and lets the anchor stand for its own zone', () => {
    expect(select(THREE_ZONES).observers).toEqual(['a1', 'b1', 'c1']);
  });

  it('picks at random inside a zone', () => {
    expect(select(THREE_ZONES, { random: () => 0.99 }).observers).toEqual(['a1', 'b2', 'c2']);
  });

  it('takes more nodes per zone when asked', () => {
    expect(select(THREE_ZONES, { nodesPerZone: 2 }).observers.sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
  });

  it('takes random nodes when no zone is known', () => {
    const nodes = [node('n1'), node('n2'), node('n3'), node('n4'), node('n5')];

    expect(select(nodes).observers).toEqual(['n1', 'n2', 'n3']);
    expect(select(nodes, { random: () => 0.99 }).observers).toEqual(['n1', 'n5', 'n4']);
  });

  it('tops a small sample up to the random node count', () => {
    const nodes = [node('a1', 'a'), node('a2', 'a'), node('a3', 'a'), node('a4', 'a')];

    expect(select(nodes).observers).toEqual(['a1', 'a2', 'a3']);
  });

  it('prefers a node that has its own registered connection', () => {
    expect(select(THREE_ZONES, { registeredIds: new Set(['b2']) }).observers).toEqual(['a1', 'b2', 'c1']);
  });

  it('asks a replica only where the zone has no primary', () => {
    const nodes = [
      node('a1', 'a'),
      replicaOf('a1', 'b0', 'b'),
      node('b1', 'b'),
      replicaOf('a1', 'c0', 'c'),
      replicaOf('b1', 'c1', 'c'),
    ];

    expect(select(nodes).observers).toEqual(['a1', 'b1', 'c0']);
  });

  it('keeps the nodes it asked last time', () => {
    expect(select(THREE_ZONES, { previous: ['a1', 'b2', 'c2'] }).observers).toEqual(['a1', 'b2', 'c2']);
  });

  it('replaces a node that left the cluster', () => {
    const nodes = THREE_ZONES.filter((n) => n.id !== 'b2');

    expect(select(nodes, { previous: ['a1', 'b2', 'c2'] }).observers).toEqual(['a1', 'b1', 'c2']);
  });

  it('replaces a node that did not answer', () => {
    const picked = select(THREE_ZONES, { previous: ['a1', 'b1', 'c1'], unanswered: new Set(['b1']) });

    expect(picked.observers).toEqual(['a1', 'b2', 'c1']);
  });

  it('keeps asking a silent node when the zone has no other', () => {
    const nodes = [node('a1', 'a'), node('b1', 'b'), node('c1', 'c')];
    const picked = select(nodes, { previous: ['a1', 'b1', 'c1'], unanswered: new Set(['b1']) });

    expect(picked.observers).toEqual(['a1', 'b1', 'c1']);
  });

  it('keeps a silent node that is part of a disagreement', () => {
    const picked = select(THREE_ZONES, {
      previous: ['a1', 'b1', 'c1'],
      unanswered: new Set(['b1']),
      frozen: new Set(['b1']),
    });

    expect(picked.observers.sort()).toEqual(['a1', 'b1', 'c1']);
  });

  it('keeps a node of a disagreement that was asked only because it was accused', () => {
    const chosen = select(THREE_ZONES, { previous: ['a1', 'b1', 'c1'], frozen: new Set(['a1', 'b1', 'c1', 'c2']) });

    expect(chosen.observers).toEqual(['a1', 'b1', 'c1', 'c2']);
    expect(chosen.sampled).toContain('c2');
  });

  it('prefers nodes the anchor sees as healthy but still asks a failing one', () => {
    const nodes = [
      node('a1', 'a'),
      node('b1', 'b', { flags: ['master', 'fail?'] }),
      node('b2', 'b'),
      node('c1', 'c', { flags: ['master', 'fail'] }),
    ];

    expect(select(nodes).observers).toEqual(['a1', 'b2', 'c1']);
  });

  it('never asks a node that is still in handshake or has no address', () => {
    const nodes = [
      node('a1', 'a'),
      node('b1', 'b', { flags: ['master', 'handshake'] }),
      node('b2', 'b', { flags: ['master', 'noaddr'] }),
      node('b3', 'b'),
    ];

    expect(select(nodes, { accused: ['b1'], randomNodes: 4 }).observers).toEqual(['a1', 'b3']);
  });

  it('also asks the nodes a view accuses of failing', () => {
    const picked = select(THREE_ZONES, { previous: ['a1', 'b1', 'c1'], accused: ['c2', 'b2', 'a2'] });

    expect(picked.observers.sort()).toEqual(['a1', 'b1', 'b2', 'c1', 'c2']);
    expect(picked.followed).toEqual(['c2', 'b2']);
    expect(picked.sampled).toEqual(['a1', 'b1', 'c1']);
  });

  it('does not count an accused node twice', () => {
    const picked = select(THREE_ZONES, { previous: ['a1', 'b1', 'c1'], accused: ['b1'] });

    expect(picked.observers).toEqual(['a1', 'b1', 'c1']);
    expect(picked.followed).toEqual([]);
  });

  it('stays under the observer limit and keeps the anchor, frozen and accused nodes', () => {
    const zones = ['a', 'b', 'c', 'd', 'e', 'f'];
    const nodes = zones.flatMap((zone) => [node(`${zone}1`, zone), node(`${zone}2`, zone)]);
    const picked = select(nodes, {
      maxObservers: 4,
      previous: ['a1', 'f2'],
      frozen: new Set(['f2']),
      accused: ['e2'],
    });

    expect(picked.observers).toEqual(['a1', 'f2', 'e2', 'b1']);
  });

  it('gives every zone a first pick before any zone gets a second', () => {
    const picked = select(THREE_ZONES, { nodesPerZone: 2, maxObservers: 4 });

    expect(picked.observers).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
});
