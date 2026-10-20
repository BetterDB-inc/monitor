import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HotKeyEntry, KeyPatternSnapshot } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';

const CONN = 'conn-a';

function snapshot(timestamp: number, pattern: string, totalMemoryBytes: number): KeyPatternSnapshot {
  return {
    id: `${pattern}-${timestamp}`,
    timestamp,
    pattern,
    keyCount: 10,
    sampledKeyCount: 10,
    keysWithTtl: 0,
    keysExpiringSoon: 0,
    totalMemoryBytes,
    avgMemoryBytes: 10,
    maxMemoryBytes: 20,
  };
}

function hotKey(capturedAt: number, keyName: string, memoryBytes: number): HotKeyEntry {
  return {
    id: `${keyName}-${capturedAt}`,
    keyName,
    connectionId: CONN,
    capturedAt,
    signalType: 'cardinality',
    memoryBytes,
    cardinality: 100,
    keyType: 'hash',
    rank: 1,
  };
}

/**
 * The key-size metric exporter's probe-skip reads storage in ways the mocked
 * PrometheusService tests cannot cover against a real adapter: the pattern probe
 * fetches a single run with startTime == endTime == latestTimestamp, and the
 * per-key probe keys off getHotKeys({ latest: true }) captured_at equality. Lock
 * both round-trips in against the SQLite adapter.
 */
describe('SqliteAdapter key-size metrics round-trip', () => {
  let storage: SqliteAdapter;
  let path: string;

  beforeEach(async () => {
    path = join(tmpdir(), `key-size-roundtrip-${Date.now()}-${Math.random()}.db`);
    storage = new SqliteAdapter({ filepath: path });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
  });

  it('returns only the newest run for an exact-match timestamp window', async () => {
    await storage.saveKeyPatternSnapshots([snapshot(1_000, 'user:*', 100)], CONN);
    await storage.saveKeyPatternSnapshots([snapshot(2_000, 'user:*', 500)], CONN);

    // Probe: newest-first, limit 1 → resolve the latest run's timestamp.
    const newest = await storage.getKeyPatternSnapshots({ connectionId: CONN, limit: 1 });
    expect(newest[0]?.timestamp).toBe(2_000);

    // Batch: the exporter fetches startTime == endTime == that timestamp and must
    // get only that run, not the older one in the staleness window.
    const run = await storage.getKeyPatternSnapshots({
      connectionId: CONN,
      startTime: 2_000,
      endTime: 2_000,
    });
    expect(run).toHaveLength(1);
    expect(run[0].timestamp).toBe(2_000);
    expect(Number(run[0].totalMemoryBytes)).toBe(500);
  });

  it('returns the latest hot-key capture with a stable captured_at for the probe', async () => {
    await storage.saveHotKeys([hotKey(1_000, 'user:1', 100)], CONN);
    await storage.saveHotKeys([hotKey(2_000, 'user:2', 900)], CONN);

    const probe = await storage.getHotKeys({
      connectionId: CONN,
      latest: true,
      signalTypes: ['cardinality'],
      limit: 1,
    });
    const batch = await storage.getHotKeys({
      connectionId: CONN,
      latest: true,
      signalTypes: ['cardinality'],
      limit: 50,
    });

    // The probe (limit 1) and the full read resolve the same latest capture, so
    // comparing captured_at across them is sound.
    expect(probe[0]?.capturedAt).toBe(2_000);
    expect(batch.every((e) => e.capturedAt === 2_000)).toBe(true);
    expect(batch.map((e) => e.keyName)).toEqual(['user:2']);
  });
});
