import { describe, it, expect } from 'vitest';
import type { ClusterNode } from '../../types/metrics';
import { formatZoneLines, parseZoneLines } from './availabilityZonesText';

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'a'.repeat(40),
    address: '10.0.0.1:7001@17001',
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 16383]],
    ...overrides,
  };
}

describe('formatZoneLines', () => {
  it('lists every node by host:port with its configured zone', () => {
    const nodes = [
      clusterNode({}),
      clusterNode({ id: 'b'.repeat(40), address: '10.0.0.2:7002@17002' }),
    ];

    expect(formatZoneLines(nodes, { '10.0.0.1:7001': 'us-east-1a' })).toBe(
      '10.0.0.1:7001=us-east-1a\n10.0.0.2:7002=',
    );
  });

  it('keeps an entry keyed by the announced hostname on that node line', () => {
    const nodes = [clusterNode({ hostname: 'Node-1.internal' })];

    expect(formatZoneLines(nodes, { 'node-1.internal:7001': 'us-east-1a' })).toBe(
      'node-1.internal:7001=us-east-1a',
    );
  });

  it('leaves out a node whose zone comes from the server', () => {
    const nodes = [
      clusterNode({ availabilityZone: 'us-east-1a' }),
      clusterNode({ id: 'b'.repeat(40), address: '10.0.0.2:7002' }),
    ];

    expect(formatZoneLines(nodes, undefined)).toBe('10.0.0.2:7002=');
  });

  it('keeps configured entries that match no current node', () => {
    expect(formatZoneLines([clusterNode({})], { '10.0.0.9:7009': 'us-east-1c' })).toBe(
      '10.0.0.1:7001=\n10.0.0.9:7009=us-east-1c',
    );
  });

  it('is empty with no nodes and no map', () => {
    expect(formatZoneLines([], undefined)).toBe('');
  });

  it('keeps the zone of a bracketed IPv6 node on that node line', () => {
    const nodes = [
      clusterNode({ address: '[2001:db8::1]:7001@17001' }),
      clusterNode({ id: 'b'.repeat(40), address: '[2001:db8::2]:7002@17002' }),
    ];

    expect(formatZoneLines(nodes, { '2001:db8::1:7001': 'us-east-1a' })).toBe(
      '2001:db8::1:7001=us-east-1a\n2001:db8::2:7002=',
    );
  });

  it('keeps the zone of an IPv6 node that CLUSTER NODES prints in the long form', () => {
    const nodes = [clusterNode({ address: '2001:DB8:0:0:0:0:0:1:7001@17001' })];

    expect(formatZoneLines(nodes, { '2001:db8::1:7001': 'us-east-1a' })).toBe(
      '2001:db8::1:7001=us-east-1a',
    );
  });
});

describe('zone lines round trip', () => {
  const nodes = [
    clusterNode({ address: '[2001:db8::1]:7001@17001' }),
    clusterNode({ id: 'b'.repeat(40), address: '[2001:db8::2]:7002@17002' }),
    clusterNode({
      id: 'c'.repeat(40),
      address: '10.0.0.3:7003@17003',
      hostname: 'Node-3.internal',
    }),
  ];

  it('gives back the saved map for bracketed CLUSTER NODES addresses', () => {
    const zones = { '2001:db8::1:7001': 'us-east-1a', 'node-3.internal:7003': 'us-east-1c' };

    expect(parseZoneLines(formatZoneLines(nodes, zones))).toEqual({ ok: true, zones });
  });

  it('saves a zone filled in on the blank line of a bracketed IPv6 node', () => {
    const text = formatZoneLines(nodes, { '2001:db8::1:7001': 'us-east-1a' }).replace(
      '2001:db8::2:7002=',
      '2001:db8::2:7002=us-east-1b',
    );

    expect(parseZoneLines(text)).toEqual({
      ok: true,
      zones: { '2001:db8::1:7001': 'us-east-1a', '2001:db8::2:7002': 'us-east-1b' },
    });
  });
});

describe('parseZoneLines', () => {
  it('reads one host:port=zone per line', () => {
    expect(
      parseZoneLines('10.0.0.1:7001=us-east-1a\n\n  Node-2.internal:7002 = us-east-1b  \n'),
    ).toEqual({
      ok: true,
      zones: { '10.0.0.1:7001': 'us-east-1a', 'node-2.internal:7002': 'us-east-1b' },
    });
  });

  it('ignores lines with no zone', () => {
    expect(parseZoneLines('10.0.0.1:7001=\n10.0.0.2:7002=us-east-1b')).toEqual({
      ok: true,
      zones: { '10.0.0.2:7002': 'us-east-1b' },
    });
  });

  it('gives an empty map for empty text', () => {
    expect(parseZoneLines('  \n')).toEqual({ ok: true, zones: {} });
  });

  it('reports the line that has no separator', () => {
    expect(parseZoneLines('10.0.0.1:7001=us-east-1a\n10.0.0.2:7002 us-east-1b')).toEqual({
      ok: false,
      error: 'Line 2: expected host:port=zone',
    });
  });

  it('reports the line with an invalid address', () => {
    expect(parseZoneLines('10.0.0.1=us-east-1a')).toEqual({
      ok: false,
      error: "Line 1: Invalid node address '10.0.0.1': expected host:port",
    });
  });

  it('reports two entries merged onto one line', () => {
    expect(parseZoneLines('10.0.0.1:7001=rack-a\n10.0.0.2:7002=rack-c10.0.0.3:7003=')).toEqual({
      ok: false,
      error: "Line 2: Availability zone for '10.0.0.2:7002' must not contain '='",
    });
  });

  it('reports the line that repeats a node', () => {
    expect(parseZoneLines('10.0.0.1:7001=a\n10.0.0.2:7002=b\n10.0.0.1:7001=c')).toEqual({
      ok: false,
      error: "Line 3: Duplicate node address '10.0.0.1:7001'",
    });
  });
});
