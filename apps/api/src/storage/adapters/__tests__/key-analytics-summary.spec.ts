import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { KeyPatternSnapshot } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';

const CONN = 'conn-a';

function snapshot(pattern: string, staleKeyCount: number | undefined): KeyPatternSnapshot {
  return {
    id: `${pattern}-${staleKeyCount}`,
    timestamp: 1_000,
    pattern,
    keyCount: 10,
    sampledKeyCount: 10,
    keysWithTtl: 0,
    keysExpiringSoon: 0,
    totalMemoryBytes: 100,
    avgMemoryBytes: 10,
    maxMemoryBytes: 20,
    staleKeyCount,
  };
}

describe('SqliteAdapter key analytics summary stale count', () => {
  let storage: SqliteAdapter;
  let path: string;

  beforeEach(async () => {
    path = join(tmpdir(), `key-analytics-summary-${Date.now()}-${Math.random()}.db`);
    storage = new SqliteAdapter({ filepath: path });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    try {
      unlinkSync(path);
    } catch {
      return;
    }
  });

  it('reports the stale count as unknown when no pattern has one', async () => {
    await storage.saveKeyPatternSnapshots([snapshot('user:*', undefined), snapshot('job:*', undefined)], CONN);

    const summary = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN);

    expect(summary?.staleKeyCount).toBeNull();
    expect(summary?.byPattern['user:*'].staleCount).toBeNull();
  });

  it('sums only the known stale counts when some patterns lack one', async () => {
    await storage.saveKeyPatternSnapshots(
      [snapshot('user:*', 3), snapshot('job:*', undefined), snapshot('cart:*', 0)],
      CONN,
    );

    const summary = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN);

    expect(summary?.staleKeyCount).toBe(3);
    expect(summary?.byPattern['job:*'].staleCount).toBeNull();
    expect(summary?.byPattern['cart:*'].staleCount).toBe(0);
  });
});

describe('PostgresAdapter key analytics summary stale count', () => {
  function adapterReturning(summaryRow: Record<string, unknown>, patternRows: Record<string, unknown>[]) {
    const adapter = new PostgresAdapter({ connectionString: 'postgres://unused' });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: patternRows.map((row) => ({ pattern: row.pattern, latest_timestamp: '1000' })) })
      .mockResolvedValueOnce({ rows: [summaryRow] })
      .mockResolvedValueOnce({ rows: patternRows })
      .mockResolvedValueOnce({ rows: [{ earliest: '1000', latest: '1000' }] });
    (adapter as unknown as { pool: { query: typeof query } }).pool = { query };
    return adapter;
  }

  const totals = {
    total_patterns: '1',
    total_keys: '10',
    total_memory_bytes: '100',
    hot_key_count: null,
    cold_key_count: null,
    keys_expiring_soon: '0',
  };

  it('reports the stale count as unknown when SUM over the patterns is NULL', async () => {
    const adapter = adapterReturning({ ...totals, stale_key_count: null }, [
      { pattern: 'user:*', key_count: 10, total_memory_bytes: '100', avg_memory_bytes: 10, stale_key_count: null },
    ]);

    const summary = await adapter.getKeyAnalyticsSummary();

    expect(summary?.staleKeyCount).toBeNull();
    expect(summary?.byPattern['user:*'].staleCount).toBeNull();
  });

  it('keeps a known stale count, including zero', async () => {
    const adapter = adapterReturning({ ...totals, stale_key_count: '0' }, [
      { pattern: 'user:*', key_count: 10, total_memory_bytes: '100', avg_memory_bytes: 10, stale_key_count: 0 },
    ]);

    const summary = await adapter.getKeyAnalyticsSummary();

    expect(summary?.staleKeyCount).toBe(0);
    expect(summary?.byPattern['user:*'].staleCount).toBe(0);
  });
});
