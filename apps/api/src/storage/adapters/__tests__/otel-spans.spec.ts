import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import type { StoredOtelSpan } from '@betterdb/shared';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('OTLP span storage (%s)', (_name, makeAdapter) => {
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

  it('prunes WHOLE traces (never splits one) by trace-level start', async () => {
    // Trace whose root is before the cutoff but a later child is after it —
    // the whole trace must go, not just the root (which would orphan the child).
    await storage.saveOtelSpans([
      span({ traceId: 'split', spanId: 'root', parentSpanId: null, startTimeMs: 1000 }),
      span({ traceId: 'split', spanId: 'child', parentSpanId: 'root', startTimeMs: 9000 }),
      span({ traceId: 'keep', spanId: 'r', parentSpanId: null, startTimeMs: 8000 }),
    ]);

    const removed = await storage.pruneOldOtelSpans(5000);
    expect(removed).toBe(2); // both spans of 'split'
    expect(await storage.getOtelTraceSpans('split')).toHaveLength(0);
    expect(await storage.getOtelTraceSpans('keep')).toHaveLength(1);
  });

  it('prunes spans older than a cutoff (by start time)', async () => {
    await storage.saveOtelSpans([
      span({ traceId: 'old', spanId: 'r', startTimeMs: 1000 }),
      span({ traceId: 'new', spanId: 'r', startTimeMs: 9000 }),
    ]);
    const removed = await storage.pruneOldOtelSpans(5000);
    expect(removed).toBe(1);
    const traces = await storage.getOtelTraces({});
    expect(traces.map((t) => t.traceId)).toEqual(['new']);
  });
});
