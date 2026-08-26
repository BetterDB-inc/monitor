import { buildEventAttributes } from '../event-attributes';

describe('buildEventAttributes', () => {
  it('always sets event.name and includes connection_id when provided', () => {
    expect(buildEventAttributes('cluster.failover', {}, 'valkey:6379')).toEqual({
      'event.name': 'cluster.failover',
      connection_id: 'valkey:6379',
    });
  });

  it('omits connection_id when not provided', () => {
    expect(buildEventAttributes('anomaly.detected', {})).toEqual({
      'event.name': 'anomaly.detected',
    });
  });

  it('keeps primitive payload fields and drops objects/undefined', () => {
    const attributes = buildEventAttributes(
      'compliance.alert',
      {
        memoryUsedPercent: 87.4,
        maxmemoryPolicy: 'noeviction',
        breached: true,
        instance: { host: 'localhost', port: 6379 },
        missing: undefined,
      },
      'c1',
    );
    expect(attributes).toEqual({
      'event.name': 'compliance.alert',
      connection_id: 'c1',
      memoryUsedPercent: 87.4,
      maxmemoryPolicy: 'noeviction',
      breached: true,
    });
  });
  it('drops arrays, which is why the failover call site serializes them', () => {
    // Pins the constraint rather than the bug: a raw array is silently
    // discarded, so `cluster.failover` shipped `ok` with no reason and no
    // changed nodes. Anything that "simplifies" the call site back to raw
    // arrays must fail here.
    const attributes = buildEventAttributes('cluster.failover', {
      clusterState: 'ok',
      reasons: ['role_change', 'epoch_bump'],
      changedNodes: [{ nodeId: 'n1', reason: 'role_change', from: 'replica', to: 'master' }],
    });
    expect(attributes).toEqual({ 'event.name': 'cluster.failover', clusterState: 'ok' });
  });

  it('keeps the serialized forms the failover call site actually sends', () => {
    const attributes = buildEventAttributes('cluster.failover', {
      clusterState: 'ok',
      reasons: ['role_change', 'epoch_bump'].join(','),
      changedNodes: JSON.stringify([
        { nodeId: 'n1', reason: 'role_change', from: 'replica', to: 'master' },
      ]),
    });
    expect(attributes.reasons).toBe('role_change,epoch_bump');
    expect(JSON.parse(attributes.changedNodes as string)).toEqual([
      { nodeId: 'n1', reason: 'role_change', from: 'replica', to: 'master' },
    ]);
  });
});
