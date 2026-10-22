import { describe, expect, it } from 'vitest';
import {
  connectionTypeSuffix,
  formatRelative,
  hasKvCacheFootprint,
  isClusterChild,
  isExternalConnection,
  isRetiredMember,
  orderWithMembers,
} from './connectionType';

describe('connectionType', () => {
  it('detects external connections', () => {
    expect(isExternalConnection({ connectionType: 'external' })).toBe(true);
    expect(isExternalConnection({ connectionType: 'direct' })).toBe(false);
    expect(isExternalConnection(null)).toBe(false);
  });

  it('labels each connection type', () => {
    expect(connectionTypeSuffix({ connectionType: 'agent' })).toBe(' · via agent');
    expect(connectionTypeSuffix({ connectionType: 'external' })).toBe(' · OTLP push');
    expect(connectionTypeSuffix({ connectionType: 'direct' })).toBe(' · direct');
    expect(connectionTypeSuffix({})).toBe(' · direct');
  });
});

describe('cluster membership helpers', () => {
  const seed = { id: 's', name: 's', host: 'h', port: 1, isConnected: true };
  const child = (id: string, extra = {}) => ({
    id, name: id, host: 'h', port: 2, isConnected: true,
    membership: { seedId: 's', nodeId: id, origin: 'auto' as const, source: 'cluster' as const, ...extra },
  });

  it('flags retired and child connections', () => {
    expect(isRetiredMember(child('a', { retiredAt: 1 }))).toBe(true);
    expect(isRetiredMember(child('a'))).toBe(false);
    expect(isClusterChild(child('a'))).toBe(true);
    expect(isClusterChild(seed)).toBe(false);
  });

  it('orders children under their seed, active before retired', () => {
    const other = { id: 'o', name: 'o', host: 'h', port: 3, isConnected: true };
    const ordered = orderWithMembers([child('r', { retiredAt: 1 }), other, child('a'), seed]);
    expect(ordered.map((e) => [e.connection.id, e.depth])).toEqual([
      ['o', 0], ['s', 0], ['a', 1], ['r', 1],
    ]);
  });

  it('keeps an orphaned child at the top level', () => {
    const orphan = { ...child('x'), membership: { seedId: 'missing', nodeId: 'x', origin: 'auto' as const, source: 'cluster' as const } };
    expect(orderWithMembers([orphan]).map((e) => e.depth)).toEqual([0]);
  });
});

describe('formatRelative', () => {
  it('formats hours ago', () => {
    expect(formatRelative(0, 3 * 3_600_000)).toBe('3h ago');
  });
});

describe('hasKvCacheFootprint', () => {
  it('limits KV cache footprint to connections the scan covers', () => {
    expect(hasKvCacheFootprint({ host: 'h', connectionType: 'direct' })).toBe(true);
    expect(hasKvCacheFootprint(null)).toBe(true);
    expect(hasKvCacheFootprint({ host: 'agent', connectionType: 'agent' })).toBe(false);
    expect(hasKvCacheFootprint({ host: 'h', connectionType: 'external' })).toBe(false);
    expect(
      hasKvCacheFootprint({
        host: 'h',
        membership: { seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster' },
      }),
    ).toBe(false);
    expect(
      hasKvCacheFootprint({
        host: 'h',
        membership: { seedId: 's', nodeId: 'n', origin: 'auto', source: 'sentinel', group: 'g', role: 'primary' },
      }),
    ).toBe(true);
  });

  it('hides KV cache footprint on Sentinel connections', () => {
    expect(hasKvCacheFootprint({ host: 'h', connectionType: 'direct', capabilities: { isSentinel: true } })).toBe(false);
    expect(hasKvCacheFootprint({ host: 'h', connectionType: 'direct', capabilities: { isSentinel: false } })).toBe(true);
  });
});
