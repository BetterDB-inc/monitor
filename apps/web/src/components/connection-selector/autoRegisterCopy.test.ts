import { describe, expect, it } from 'vitest';
import type { Connection } from '../../hooks/useConnection';
import {
  autoRegisterDefaultFor,
  deleteConfirmation,
  disableConfirmation,
  groupSentinelMembers,
  showsAutoRegisterToggle,
} from './autoRegisterCopy';

const seed: Connection = { id: 's', name: 'prod', host: 'h', port: 7001, isConnected: true, capabilities: { dbType: 'valkey', version: '8', clusterEnabled: true } };
const auto = (id: string, retiredAt?: number): Connection => ({ id, name: id, host: 'h', port: 1, isConnected: true, membership: { seedId: 's', nodeId: id, origin: 'auto', source: 'cluster', retiredAt } });
const adopted: Connection = { id: 'm', name: 'mine', host: 'h', port: 2, isConnected: true, membership: { seedId: 's', nodeId: 'm', origin: 'adopted', source: 'cluster' } };

describe('auto-register copy', () => {
  it('warns that deleting a seed deletes its auto nodes and keeps adopted ones', () => {
    expect(deleteConfirmation(seed, [seed, auto('a'), auto('b', 1), adopted])).toBe(
      'Delete prod? This also deletes 2 auto-registered nodes; adopted connections are kept.',
    );
  });

  it('warns that a deleted auto node comes back', () => {
    expect(deleteConfirmation(auto('a'), [seed, auto('a')])).toBe(
      'Delete a? It will be registered again on the next sync unless auto-registration is turned off on prod.',
    );
  });

  it('uses the plain prompt for other connections', () => {
    expect(deleteConfirmation(adopted, [seed, adopted])).toBe('Are you sure you want to delete this connection?');
  });

  it('counts active auto nodes when disabling', () => {
    expect(disableConfirmation(seed, [seed, auto('a'), auto('b', 1), adopted])).toBe(
      '1 auto-registered node will be retired. Its history is kept.',
    );
  });

  it('shows the toggle only on cluster seeds', () => {
    expect(showsAutoRegisterToggle(seed)).toBe(true);
    expect(showsAutoRegisterToggle({ ...seed, capabilities: { dbType: 'valkey', version: '8', clusterEnabled: false } })).toBe(false);
    expect(showsAutoRegisterToggle(auto('a'))).toBe(false);
    expect(showsAutoRegisterToggle({ ...seed, connectionType: 'external' })).toBe(false);
  });

  it('shows the toggle for sentinel seeds', () => {
    const sentinel: Connection = { id: 's', name: 's', host: 's1', port: 26379, isConnected: true, capabilities: { dbType: 'valkey', version: '8', isSentinel: true } };
    expect(showsAutoRegisterToggle(sentinel)).toBe(true);
  });

  it('picks the per-kind default', () => {
    const sentinel: Connection = { id: 's', name: 's', host: 's1', port: 26379, isConnected: true, capabilities: { dbType: 'valkey', version: '8', isSentinel: true } };
    const cluster: Connection = { id: 'c', name: 'c', host: 'c1', port: 7001, isConnected: true, capabilities: { dbType: 'valkey', version: '8', clusterEnabled: true } };
    const defaults = { cluster: true, sentinel: false };
    expect(autoRegisterDefaultFor(sentinel, defaults)).toBe(false);
    expect(autoRegisterDefaultFor(cluster, defaults)).toBe(true);
  });

  it('groups sentinel members by group with the primary first', () => {
    const m = (id: string, group: string, role: 'primary' | 'replica'): Connection => ({
      id,
      name: id,
      host: id,
      port: 6379,
      isConnected: true,
      membership: { seedId: 's', nodeId: id, origin: 'auto', source: 'sentinel', group, role },
    });
    expect(
      groupSentinelMembers('s', [m('r1', 'b', 'replica'), m('p1', 'b', 'primary'), m('p2', 'a', 'primary')]),
    ).toEqual([
      { group: 'a', members: [m('p2', 'a', 'primary')] },
      { group: 'b', members: [m('p1', 'b', 'primary'), m('r1', 'b', 'replica')] },
    ]);
  });
});
