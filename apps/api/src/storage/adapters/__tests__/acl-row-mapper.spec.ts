import { PostgresDialect, RowMappers } from '../base-sql.adapter';

describe('RowMappers.mapAclEntryRow', () => {
  it('returns the timestamps PostgreSQL sends as BIGINT strings as numbers', () => {
    const entry = new RowMappers(PostgresDialect).mapAclEntryRow({
      id: 1,
      count: 1,
      reason: 'auth',
      context: 'toplevel',
      object: 'AUTH',
      username: 'app',
      age_seconds: 1,
      client_info: 'id=1 addr=10.0.0.1:5000',
      timestamp_created: '1699913600',
      timestamp_last_updated: '1699913601',
      captured_at: '1699913602',
      source_host: 'localhost',
      source_port: 6379,
      connection_id: 'conn-1',
    });

    expect(entry).toMatchObject({
      timestampCreated: 1699913600,
      timestampLastUpdated: 1699913601,
      capturedAt: 1699913602,
    });
  });
});
