import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { LogCaptureGap } from '@betterdb/shared';
import {
  LOG_CAPTURE_GAP_LIST_MAX,
  type LogCaptureGapRepository,
} from '../../../common/interfaces/log-capture-gap-repository.interface';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

const POSTGRES_DSN =
  process.env.LOG_CAPTURE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({
      host: process.env.PROBE_HOST,
      port: Number(process.env.PROBE_PORT),
    });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

function gap(overrides: Partial<LogCaptureGap> = {}): LogCaptureGap {
  return {
    id: randomUUID(),
    connectionId: 'conn-a',
    logType: 'slowlog',
    firstMissingId: 101,
    lastMissingId: 272,
    missingCount: 172,
    cause: 'server_evicted',
    capturedCount: 128,
    previousPollAt: 970_000,
    detectedAt: 1_000_000,
    ...overrides,
  };
}

function describeRepository(
  name: string,
  open: () => Promise<StoragePort>,
  describeFn: jest.Describe = describe,
): void {
  describeFn(`LogCaptureGapRepository (${name})`, () => {
    let storage: StoragePort;
    let repository: LogCaptureGapRepository;

    beforeEach(async () => {
      storage = await open();
      repository = storage.getLogCaptureGapRepository();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('round-trips every field, including a null previousPollAt', async () => {
      const withPoll = gap({ id: 'a', detectedAt: 2_000 });
      const withoutPoll = gap({
        id: 'b',
        detectedAt: 1_000,
        previousPollAt: null,
        cause: 'monitor_offline',
        logType: 'commandlog-large-reply',
      });
      await repository.insert(withPoll);
      await repository.insert(withoutPoll);

      expect(await repository.list({ connectionId: 'conn-a' })).toEqual([withPoll, withoutPoll]);
    });

    it('keeps ids beyond 32 bits intact', async () => {
      const big = gap({ firstMissingId: 5_000_000_001, lastMissingId: 5_000_000_999, missingCount: 999 });
      await repository.insert(big);
      const [stored] = await repository.list({ connectionId: 'conn-a' });
      expect(stored.firstMissingId).toBe(5_000_000_001);
      expect(stored.lastMissingId).toBe(5_000_000_999);
    });

    it('scopes by connection and filters by log type and detection window', async () => {
      await repository.insert(gap({ id: '1', detectedAt: 100 }));
      await repository.insert(gap({ id: '2', detectedAt: 200, logType: 'commandlog-slow' }));
      await repository.insert(gap({ id: '3', detectedAt: 300 }));
      await repository.insert(gap({ id: '4', detectedAt: 300, connectionId: 'conn-b' }));

      const ids = async (query: Parameters<LogCaptureGapRepository['list']>[0]) =>
        (await repository.list(query)).map((row) => row.id);

      expect(await ids({ connectionId: 'conn-a' })).toEqual(['3', '2', '1']);
      expect(await ids({ connectionId: 'conn-b' })).toEqual(['4']);
      expect(await ids({ connectionId: 'conn-a', logType: 'slowlog' })).toEqual(['3', '1']);
      expect(await ids({ connectionId: 'conn-a', since: 200 })).toEqual(['3', '2']);
      expect(await ids({ connectionId: 'conn-a', until: 200 })).toEqual(['2', '1']);
      expect(await ids({ connectionId: 'conn-a', since: 150, until: 250 })).toEqual(['2']);
    });

    it('orders by detectedAt then id descending and honours the limit', async () => {
      await repository.insert(gap({ id: 'a', detectedAt: 10 }));
      await repository.insert(gap({ id: 'c', detectedAt: 30 }));
      await repository.insert(gap({ id: 'b', detectedAt: 30 }));

      expect((await repository.list({ connectionId: 'conn-a' })).map((row) => row.id)).toEqual([
        'c',
        'b',
        'a',
      ]);
      expect((await repository.list({ connectionId: 'conn-a', limit: 2 })).map((row) => row.id)).toEqual([
        'c',
        'b',
      ]);
    });

    it('caps an oversized or invalid limit', async () => {
      await repository.insert(gap({ id: 'only' }));
      expect(await repository.list({ connectionId: 'conn-a', limit: LOG_CAPTURE_GAP_LIST_MAX * 10 })).toHaveLength(1);
      expect(await repository.list({ connectionId: 'conn-a', limit: 0 })).toHaveLength(1);
      expect(await repository.list({ connectionId: 'conn-a', limit: -5 })).toHaveLength(1);
    });

    it('prunes rows detected before the cutoff, optionally for one connection', async () => {
      await repository.insert(gap({ id: 'old-a', detectedAt: 100 }));
      await repository.insert(gap({ id: 'old-b', detectedAt: 100, connectionId: 'conn-b' }));
      await repository.insert(gap({ id: 'new-a', detectedAt: 500 }));

      expect(await repository.prune(200, 'conn-b')).toBe(1);
      expect((await repository.list({ connectionId: 'conn-b' })).length).toBe(0);
      expect((await repository.list({ connectionId: 'conn-a' })).map((row) => row.id)).toEqual([
        'new-a',
        'old-a',
      ]);

      expect(await repository.prune(200)).toBe(1);
      expect((await repository.list({ connectionId: 'conn-a' })).map((row) => row.id)).toEqual(['new-a']);
    });

    it('summarizes per log and cause within the window and connection', async () => {
      await repository.insert(gap({ id: '1', detectedAt: 100, missingCount: 10, capturedCount: 128 }));
      await repository.insert(gap({ id: '2', detectedAt: 300, missingCount: 500, capturedCount: 128 }));
      await repository.insert(gap({ id: '3', detectedAt: 200, missingCount: 7, capturedCount: 5, cause: 'monitor_offline' }));
      await repository.insert(gap({ id: '4', detectedAt: 250, missingCount: 1, capturedCount: 1, logType: 'commandlog-slow' }));
      await repository.insert(gap({ id: 'old', detectedAt: 10, missingCount: 99_999 }));
      await repository.insert(gap({ id: 'other', detectedAt: 300, connectionId: 'conn-b', missingCount: 99_999 }));

      const rows = await repository.summarize('conn-a', 50);
      const key = (row: { logType: string; cause: string }) => `${row.logType}|${row.cause}`;
      expect(rows.sort((a, b) => key(a).localeCompare(key(b)))).toEqual([
        { logType: 'commandlog-slow', cause: 'server_evicted', gapCount: 1, missingCount: 1, peakArrivals: 2, lastGapAt: 250 },
        { logType: 'slowlog', cause: 'monitor_offline', gapCount: 1, missingCount: 7, peakArrivals: 12, lastGapAt: 200 },
        { logType: 'slowlog', cause: 'server_evicted', gapCount: 2, missingCount: 510, peakArrivals: 628, lastGapAt: 300 },
      ]);
      expect(await repository.summarize('conn-a', 1_000)).toEqual([]);
    });

    it('isolates stored rows from caller mutation', async () => {
      const original = gap({ id: 'x' });
      await repository.insert(original);
      original.missingCount = 1;
      const [listed] = await repository.list({ connectionId: 'conn-a' });
      listed.missingCount = 2;
      const [stored] = await repository.list({ connectionId: 'conn-a' });
      expect(stored.missingCount).toBe(172);
    });
  });
}

describeRepository('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteFiles: string[] = [];

describeRepository('sqlite', async () => {
  const filepath = path.join(os.tmpdir(), `log-capture-gaps-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const adapter = new SqliteAdapter({ filepath });
  await adapter.initialize();
  return adapter;
});

const postgresSchemas: string[] = [];

describeRepository(
  'postgres',
  async () => {
    const schema = `log_capture_gaps_${randomUUID().replace(/-/g, '')}`;
    postgresSchemas.push(schema);
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  },
  isReachable(POSTGRES_DSN) ? describe : describe.skip,
);

afterAll(async () => {
  for (const filepath of sqliteFiles) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
  if (postgresSchemas.length === 0) {
    return;
  }
  const pool = new Pool({ connectionString: POSTGRES_DSN });
  try {
    for (const schema of postgresSchemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  } finally {
    await pool.end();
  }
});
