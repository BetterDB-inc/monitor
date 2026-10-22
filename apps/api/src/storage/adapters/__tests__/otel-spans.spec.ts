import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import type { StoredOtelSpan } from '@betterdb/shared';

const POSTGRES_DSN =
  process.env.OTEL_SPANS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

function postgresRequired(): boolean {
  const flag = process.env.REQUIRE_POSTGRES_TESTS;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.CI === 'true';
}

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

const postgresReachable = isReachable(POSTGRES_DSN);
if (!postgresReachable && postgresRequired()) {
  describe('OTLP span storage (PostgresAdapter, live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(POSTGRES_DSN).host} is unreachable`,
      );
    });
  });
}

// Each Postgres adapter gets its own schema so tests stay isolated; dropped in afterAll.
const postgresSchemas: string[] = [];
afterAll(async () => {
  if (postgresSchemas.length === 0) return;
  const pool = new Pool({ connectionString: POSTGRES_DSN });
  try {
    for (const schema of postgresSchemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  } finally {
    await pool.end();
  }
});

const adapters: Array<[string, () => unknown]> = [
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
];
if (postgresReachable) {
  adapters.push([
    'PostgresAdapter',
    () => {
      const schema = `otel_spans_${randomUUID().replace(/-/g, '')}`;
      postgresSchemas.push(schema);
      return new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    },
  ]);
}

describe.each(adapters)('OTLP span storage (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });
  afterEach(async () => {
    await storage.close();
  });

  const span = (o: Partial<StoredOtelSpan> = {}): StoredOtelSpan => ({
    traceId: 't1',
    spanId: 's1',
    parentSpanId: null,
    name: 'chat.turn',
    scopeName: '',
    serviceName: 'betterdb-playground-chat',
    kind: 1,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000742000000',
    startTimeMs: 1_700_000_000_000,
    durationNs: 742_000_000,
    statusCode: 1,
    statusMessage: null,
    attributes: '{}',
    ingestedAt: 1_700_000_000_100,
    ...o,
  });

  it('stores spans and rebuilds a trace summary from the root + children', async () => {
    await storage.saveOtelSpans([
      span({ spanId: 'root', parentSpanId: null, name: 'chat.turn', durationNs: 742_000_000 }),
      span({
        spanId: 'c1',
        parentSpanId: 'root',
        name: 'agent_cache.llm.check',
        scopeName: '@betterdb/agent-cache',
        startTimeMs: 1_700_000_000_010,
        durationNs: 1_000_000,
        statusCode: 1,
      }),
      span({
        spanId: 'c2',
        parentSpanId: 'root',
        name: 'semantic_cache.check',
        scopeName: '@betterdb/semantic-cache',
        startTimeMs: 1_700_000_000_020,
        durationNs: 448_000_000,
        statusCode: 2, // error
      }),
    ]);

    const traces = await storage.getOtelTraces({});
    expect(traces).toHaveLength(1);
    const t = traces[0];
    expect(t.traceId).toBe('t1');
    expect(t.rootName).toBe('chat.turn');
    expect(t.serviceName).toBe('betterdb-playground-chat');
    expect(t.spanCount).toBe(3);
    expect(t.betterdbSpanCount).toBe(2); // agent-cache + semantic-cache
    expect(t.durationNs).toBe(742_000_000); // root's duration
    expect(t.hasError).toBe(true);
  });

  it('returns a trace spans tree ordered by start time', async () => {
    await storage.saveOtelSpans([
      span({ spanId: 'b', parentSpanId: 'a', startTimeMs: 1_700_000_000_020 }),
      span({ spanId: 'a', parentSpanId: null, startTimeMs: 1_700_000_000_000 }),
    ]);
    const spans = await storage.getOtelTraceSpans('t1');
    expect(spans.map((s) => s.spanId)).toEqual(['a', 'b']);
  });

  it('handles duplicate (traceId, spanId) within a single save batch', async () => {
    // A single multi-row INSERT ... ON CONFLICT DO UPDATE errors on Postgres if the
    // same key appears twice in one batch, so saveOtelSpans must dedupe (last wins).
    const stored = await storage.saveOtelSpans([
      span({ spanId: 'dup', name: 'first' }),
      span({ spanId: 'dup', name: 'second' }),
    ]);
    expect(stored).toBeGreaterThanOrEqual(1);
    const spans = await storage.getOtelTraceSpans('t1');
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('second');
  });

  it('dedupes on (traceId, spanId)', async () => {
    await storage.saveOtelSpans([span({ spanId: 'x', name: 'first' })]);
    await storage.saveOtelSpans([span({ spanId: 'x', name: 'again' })]);
    const spans = await storage.getOtelTraceSpans('t1');
    expect(spans).toHaveLength(1);
  });

  it('filters traces by time window and service', async () => {
    await storage.saveOtelSpans([
      span({ traceId: 'old', spanId: 'r', startTimeMs: 1000, serviceName: 'svc-a' }),
      span({ traceId: 'new', spanId: 'r', startTimeMs: 9000, serviceName: 'svc-b' }),
    ]);
    const windowed = await storage.getOtelTraces({ startTime: 5000, endTime: 10_000 });
    expect(windowed.map((t) => t.traceId)).toEqual(['new']);

    const byService = await storage.getOtelTraces({ service: 'svc-a' });
    expect(byService.map((t) => t.traceId)).toEqual(['old']);
  });

  it('keeps ALL spans of a boundary trace whose start is in the window', async () => {
    // Root starts inside the window; a later child starts outside it. The trace
    // must still summarize with the full span count, not a partial one.
    await storage.saveOtelSpans([
      span({ traceId: 'bt', spanId: 'root', parentSpanId: null, startTimeMs: 4000, durationNs: 6_000_000 }),
      span({ traceId: 'bt', spanId: 'child', parentSpanId: 'root', startTimeMs: 9000, durationNs: 1_000_000 }),
    ]);

    const [t] = await storage.getOtelTraces({ startTime: 0, endTime: 5000 });
    expect(t.traceId).toBe('bt');
    expect(t.spanCount).toBe(2); // child (start 9000, outside window) still included
    expect(t.rootName).toBe('chat.turn');
    expect(t.durationNs).toBe(6_000_000); // root duration, not a truncated value
  });

  it('prunes WHOLE traces (never splits one) by trace-level ingest time', async () => {
    // Trace whose root was ingested before the cutoff but a later child after
    // it — the whole trace must go, not just the root (which would orphan the
    // child).
    await storage.saveOtelSpans([
      span({ traceId: 'split', spanId: 'root', parentSpanId: null, ingestedAt: 1000 }),
      span({ traceId: 'split', spanId: 'child', parentSpanId: 'root', ingestedAt: 9000 }),
      span({ traceId: 'keep', spanId: 'r', parentSpanId: null, ingestedAt: 8000 }),
    ]);

    const removed = await storage.pruneOldOtelSpans(5000);
    expect(removed).toBe(2); // both spans of 'split'
    expect(await storage.getOtelTraceSpans('split')).toHaveLength(0);
    expect(await storage.getOtelTraceSpans('keep')).toHaveLength(1);
  });

  it('keeps traces whole across prune batches (no orphaned late spans)', async () => {
    // Regression: a rowid-chunked delete re-evaluated the "old traces" probe
    // per batch, so once a trace's old spans were removed its newer spans no
    // longer matched and survived as orphans. Force multiple batches (the
    // sqlite path selects 1000 trace ids per round) with a mixed-age trace in
    // the pool and assert it is deleted atomically.
    const singles: StoredOtelSpan[] = [];
    for (let i = 0; i < 1_100; i++) {
      singles.push(span({ traceId: `old-${i}`, spanId: 'r', ingestedAt: 1000 + i }));
    }
    await storage.saveOtelSpans([
      ...singles,
      span({ traceId: 'mixed', spanId: 'root', parentSpanId: null, ingestedAt: 1000 }),
      span({ traceId: 'mixed', spanId: 'late', parentSpanId: 'root', ingestedAt: 9000 }),
      span({ traceId: 'keep', spanId: 'r', parentSpanId: null, ingestedAt: 8000 }),
    ]);

    const removed = await storage.pruneOldOtelSpans(5000);

    expect(removed).toBe(1_100 + 2); // every old single plus BOTH spans of 'mixed'
    expect(await storage.getOtelTraceSpans('mixed')).toHaveLength(0);
    expect(await storage.getOtelTraceSpans('keep')).toHaveLength(1);
  });

  it('prunes spans older than a cutoff (by ingest time)', async () => {
    await storage.saveOtelSpans([
      span({ traceId: 'old', spanId: 'r', startTimeMs: 1000, ingestedAt: 1000 }),
      span({ traceId: 'new', spanId: 'r', startTimeMs: 9000, ingestedAt: 9000 }),
    ]);
    const removed = await storage.pruneOldOtelSpans(5000);
    expect(removed).toBe(1);
    const traces = await storage.getOtelTraces({});
    expect(traces.map((t) => t.traceId)).toEqual(['new']);
  });

  it('prunes by server ingest time, never the sender-supplied start time (GHSA-3pjj)', async () => {
    // The DoS: a sender-controlled far-future startTimeMs used to make spans
    // permanently un-prunable. Retention must key on the server-stamped
    // ingestedAt, so the hostile span ages out like any other.
    const FAR_FUTURE_MS = 99_999_999_999_999; // year ~5138
    await storage.saveOtelSpans([
      span({ traceId: 'hostile', spanId: 'r', startTimeMs: FAR_FUTURE_MS, ingestedAt: 1000 }),
      span({ traceId: 'honest', spanId: 'r', startTimeMs: 2000, ingestedAt: 9000 }),
    ]);

    const removed = await storage.pruneOldOtelSpans(5000);
    expect(removed).toBe(1);
    expect(await storage.getOtelTraceSpans('hostile')).toHaveLength(0);
    expect(await storage.getOtelTraceSpans('honest')).toHaveLength(1);
  });

  describe('retained-span cap', () => {
    const CAP_ENV = 'OTEL_MAX_RETAINED_SPANS';
    let previousCap: string | undefined;

    beforeEach(() => {
      previousCap = process.env[CAP_ENV];
      process.env[CAP_ENV] = '4';
    });
    afterEach(() => {
      if (previousCap === undefined) delete process.env[CAP_ENV];
      else process.env[CAP_ENV] = previousCap;
    });

    it('evicts whole oldest-ingested traces once the store exceeds the cap', async () => {
      // 3 traces x 2 spans = 6 > cap of 4. Every adapter enforces the cap on
      // save (memory inline, the SQL adapters every N inserts) and again during
      // pruneOldOtelSpans — after which the store must be back under the cap,
      // the oldest trace evicted first and the newest kept whole.
      await storage.saveOtelSpans([
        span({ traceId: 't-old', spanId: 'a', ingestedAt: 1000 }),
        span({ traceId: 't-old', spanId: 'b', ingestedAt: 1001 }),
        span({ traceId: 't-mid', spanId: 'a', ingestedAt: 2000 }),
        span({ traceId: 't-mid', spanId: 'b', ingestedAt: 2001 }),
        span({ traceId: 't-new', spanId: 'a', ingestedAt: 3000 }),
        span({ traceId: 't-new', spanId: 'b', ingestedAt: 3001 }),
      ]);
      await storage.pruneOldOtelSpans(0); // time prune is a no-op; cap applies

      const traces = await storage.getOtelTraces({});
      const totalSpans = traces.reduce((n, t) => n + t.spanCount, 0);
      expect(totalSpans).toBeLessThanOrEqual(4);
      expect(await storage.getOtelTraceSpans('t-old')).toHaveLength(0); // oldest evicted
      expect(await storage.getOtelTraceSpans('t-new')).toHaveLength(2); // newest kept whole
    });

    it('enforces the cap on save, without waiting for a prune sweep (GHSA-3pjj)', async () => {
      // Review gap: if the cap were only applied inside pruneOldOtelSpans, the
      // public ingest route could grow the store unbounded between sweeps.
      // Saving past the cap must bring the store back down on its own — note
      // there is NO pruneOldOtelSpans call here.
      await storage.saveOtelSpans([
        span({ traceId: 't1', spanId: 'a', ingestedAt: 1000 }),
        span({ traceId: 't1', spanId: 'b', ingestedAt: 1001 }),
        span({ traceId: 't2', spanId: 'a', ingestedAt: 2000 }),
        span({ traceId: 't2', spanId: 'b', ingestedAt: 2001 }),
        span({ traceId: 't3', spanId: 'a', ingestedAt: 3000 }),
        span({ traceId: 't3', spanId: 'b', ingestedAt: 3001 }),
      ]);

      const traces = await storage.getOtelTraces({});
      const totalSpans = traces.reduce((n, t) => n + t.spanCount, 0);
      expect(totalSpans).toBeLessThanOrEqual(4);
      expect(await storage.getOtelTraceSpans('t3')).toHaveLength(2); // newest kept whole
    });

    it('drains to the low-water mark, not just back to the cap', async () => {
      // With cap 4 the low-water mark is floor(4 * 0.9) = 3. A single pass must
      // bring the store to <= low-water (not just <= cap), so a sustained flood
      // triggers the expensive eviction once per headroom's worth of inserts
      // instead of on effectively every save at the cap.
      await storage.saveOtelSpans(
        Array.from({ length: 10 }, (_, i) =>
          span({ traceId: `t${i}`, spanId: 'a', ingestedAt: 1000 + i }),
        ),
      );
      await storage.pruneOldOtelSpans(0); // time prune is a no-op; cap applies

      const traces = await storage.getOtelTraces({});
      const totalSpans = traces.reduce((n, t) => n + t.spanCount, 0);
      expect(totalSpans).toBeLessThanOrEqual(3); // drained past the cap to low-water
      expect(totalSpans).toBeGreaterThan(0);
      // The newest trace is always among those kept.
      expect(await storage.getOtelTraceSpans('t9')).toHaveLength(1);
      // An oldest trace is gone.
      expect(await storage.getOtelTraceSpans('t0')).toHaveLength(0);
    });
  });
});

(postgresReachable ? describe : describe.skip)('PostgresAdapter idx_otel_ingested', () => {
  const indexValid = async (pool: Pool, schema: string): Promise<boolean | undefined> => {
    const result = await pool.query(
      `SELECT i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'idx_otel_ingested'`,
      [schema],
    );
    return result.rows[0]?.valid;
  };

  // Boot (and close) an adapter on `schema`, creating it on first use.
  const boot = async (schema: string): Promise<void> => {
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    await adapter.close();
  };
  const newSchema = (): string => {
    const schema = `otel_spans_${randomUUID().replace(/-/g, '')}`;
    postgresSchemas.push(schema);
    return schema;
  };
  // What a failed CREATE INDEX CONCURRENTLY leaves behind. Flipping the flag
  // directly needs superuser, which the test database user is.
  const markInvalid = (pool: Pool, schema: string) =>
    pool.query(
      `UPDATE pg_index SET indisvalid = false
        WHERE indexrelid = (
          SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = 'idx_otel_ingested')`,
      [schema],
    );

  it('rebuilds an INVALID index left by an interrupted concurrent build', async () => {
    const schema = newSchema();
    await boot(schema);

    const pool = new Pool({ connectionString: POSTGRES_DSN });
    try {
      await markInvalid(pool, schema);
      expect(await indexValid(pool, schema)).toBe(false);

      await boot(schema);

      expect(await indexValid(pool, schema)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("is not blocked by another schema's build lock", async () => {
    const tenantA = newSchema();
    const tenantB = newSchema();
    await boot(tenantA);
    await boot(tenantB);

    const pool = new Pool({ connectionString: POSTGRES_DSN });
    const blocker = await pool.connect();
    const advisoryLocksHeld = async (): Promise<number> =>
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted",
        )
      ).rows[0].n;
    const waitForAdvisoryLocks = async (n: number, what: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while ((await advisoryLocksHeld()) < n) {
        if (Date.now() > deadline) throw new Error(what);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    let bootA: Promise<void> | undefined;
    let bootB: Promise<void> | undefined;
    try {
      await markInvalid(pool, tenantA);
      await markInvalid(pool, tenantB);
      // Stall a real tenant-A boot mid-build: a SHARE lock on A's table lets
      // createSchema through but blocks the DROP INDEX CONCURRENTLY of A's
      // invalid index, so A sits on its build lock, as a replica would.
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE ${tenantA}.otel_spans IN SHARE MODE`);
      bootA = boot(tenantA);
      await waitForAdvisoryLocks(1, 'tenant A never took its build lock');

      // B must take its own build lock rather than find A's and skip. (B's
      // CREATE INDEX CONCURRENTLY then waits on A's stalled statement, since
      // concurrent builds wait for older snapshots database-wide, so B only
      // finishes once A is released.)
      bootB = boot(tenantB);
      await waitForAdvisoryLocks(2, "tenant B skipped its build: A's lock blocked it");

      await blocker.query('COMMIT');
      await Promise.all([bootA, bootB]);
      expect(await indexValid(pool, tenantA)).toBe(true);
      expect(await indexValid(pool, tenantB)).toBe(true);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined); // no-op after COMMIT
      blocker.release();
      await Promise.allSettled([bootA, bootB]);
      await pool.end();
    }
  });
});

describe('MemoryAdapter retained-span byte budget', () => {
  const BYTES_ENV = 'OTEL_MAX_RETAINED_SPAN_BYTES';
  let previous: string | undefined;
  let storage: MemoryAdapter;

  beforeEach(async () => {
    previous = process.env[BYTES_ENV];
    // ~10 spans of the size below; far under the default span-count cap.
    process.env[BYTES_ENV] = String(10 * 2 * 5_000);
    storage = new MemoryAdapter();
    await storage.initialize();
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env[BYTES_ENV];
    else process.env[BYTES_ENV] = previous;
    await storage.close();
  });

  const bigSpan = (i: number): StoredOtelSpan => ({
    traceId: `t${i}`,
    spanId: 's',
    parentSpanId: null,
    name: 'chat.turn',
    scopeName: '',
    serviceName: null,
    kind: 1,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    startTimeMs: 0,
    durationNs: 0,
    statusCode: 0,
    statusMessage: null,
    attributes: JSON.stringify({ blob: 'x'.repeat(4_900) }),
    ingestedAt: 1000 + i,
  });

  it('evicts oldest traces on bytes before the span-count cap is reached (GHSA-3pjj)', async () => {
    // The span-count cap alone let a flood of max-size spans grow the heap to
    // cap x span size; the byte budget must bind first.
    for (let i = 0; i < 50; i++) await storage.saveOtelSpans([bigSpan(i)]);

    const traces = await storage.getOtelTraces({ limit: 1000 });
    expect(traces.length).toBeLessThanOrEqual(10);
    expect(traces.length).toBeGreaterThan(0);
    expect(await storage.getOtelTraceSpans('t49')).toHaveLength(1); // newest kept
    expect(await storage.getOtelTraceSpans('t0')).toHaveLength(0); // oldest evicted
  });

  it('does not double-count re-sent spans', async () => {
    // An upsert replaces the span's bytes rather than adding to them, so
    // re-sending the same span never evicts anything.
    for (let i = 0; i < 100; i++) await storage.saveOtelSpans([bigSpan(1), bigSpan(2)]);
    expect(await storage.getOtelTraceSpans('t1')).toHaveLength(1);
    expect(await storage.getOtelTraceSpans('t2')).toHaveLength(1);
  });
});
