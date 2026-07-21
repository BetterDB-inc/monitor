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
});
