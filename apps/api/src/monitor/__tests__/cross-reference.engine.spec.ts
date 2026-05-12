import type {
  StoragePort,
  StoredCaptureChunk,
  StoredCaptureSession,
  StoredSlowLogEntry,
  StoredCommandLogEntry,
  StoredClientSnapshot,
  StoredAclEntry,
} from '../../common/interfaces/storage-port.interface';
import {
  CrossReferenceEngine,
  computeBaselineRange,
  computeHotKeyDelta,
  computeNewShapes,
  computeSlowlogRegressions,
  percentile,
  shapeOf,
  shapeOfStringArray,
} from '../cross-reference.engine';
import { parseMonitorLine } from '../monitor-line.parser';

const CONNECTION_ID = 'conn-1';
const SESSION_ID = 'sess-1';
const SESSION_START_MS = 1_700_000_000_000;
const SESSION_END_MS = SESSION_START_MS + 5_000;

// ---------------------------------------------------------------------------
// Pure-helper tests (the engine's deepest internals)
// ---------------------------------------------------------------------------

describe('computeBaselineRange', () => {
  it.each([
    ['6h', 6 * 60 * 60 * 1000],
    ['24h', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
  ])('%s window spans %d ms before session start', (window, span) => {
    const r = computeBaselineRange(window as never, SESSION_START_MS);
    expect(r.baselineEndMs).toBe(SESSION_START_MS);
    expect(r.baselineEndMs - r.baselineStartMs).toBe(span);
  });

  it('same-hour-last-week shifts back 7 days and uses a one-hour window', () => {
    const r = computeBaselineRange('same-hour-last-week', SESSION_START_MS);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(r.baselineStartMs).toBe(SESSION_START_MS - sevenDaysMs);
    expect(r.baselineEndMs - r.baselineStartMs).toBe(60 * 60 * 1000);
  });
});

describe('shapeOf', () => {
  it('encodes regular commands as VERB:arity', () => {
    const line = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "GET" "foo"')!;
    expect(shapeOf(line)).toEqual({ shape: 'GET:1', cmd: 'GET', arity: 1, scriptSha: null });
  });

  it('preserves SHA for EVALSHA', () => {
    const line = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "EVALSHA" "abc123" "1" "k"')!;
    expect(shapeOf(line)).toEqual({
      shape: 'EVALSHA:abc123',
      cmd: 'EVALSHA',
      arity: null,
      scriptSha: 'abc123',
    });
  });

  it('preserves function name for FCALL', () => {
    const line = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "FCALL" "my_fn" "1" "k"')!;
    expect(shapeOf(line)).toEqual({
      shape: 'FCALL:my_fn',
      cmd: 'FCALL',
      arity: null,
      scriptSha: 'my_fn',
    });
  });

  it('preserves function name for FCALL_RO', () => {
    const line = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "FCALL_RO" "ro_fn" "0"')!;
    expect(shapeOf(line).shape).toBe('FCALL_RO:ro_fn');
  });

  it('encodes 0-arg commands as VERB:0', () => {
    const line = parseMonitorLine('1700000000.0 [0 1.2.3.4:5] "PING"')!;
    expect(shapeOf(line).shape).toBe('PING:0');
  });
});

describe('shapeOfStringArray', () => {
  it('matches shapeOf for regular commands', () => {
    expect(shapeOfStringArray(['GET', 'foo'])).toBe('GET:1');
    expect(shapeOfStringArray(['SET', 'k', 'v'])).toBe('SET:2');
  });

  it('matches shapeOf for scripted commands', () => {
    expect(shapeOfStringArray(['EVALSHA', 'abc123', '1', 'k'])).toBe('EVALSHA:abc123');
  });
});

describe('percentile', () => {
  it('returns 0 for empty input', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('linear-interpolates between samples', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeNewShapes
// ---------------------------------------------------------------------------

function parseAll(lines: string[]) {
  return lines.map((l) => parseMonitorLine(l)).filter((x): x is NonNullable<typeof x> => !!x);
}

describe('computeNewShapes', () => {
  const captured = parseAll([
    '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
    '1700000000.1 [0 1.2.3.4:5] "GET" "bar"',
    '1700000000.2 [0 1.2.3.4:5] "LPUSH" "x" "v"',
    '1700000000.3 [0 1.2.3.4:5] "EVALSHA" "deadbeef" "1" "k"',
  ]);

  it('flags shapes never seen in baseline', () => {
    const baseline = new Set(['GET:1']);
    const result = computeNewShapes(captured, baseline);
    const shapes = result.map((r) => r.shape).sort();
    expect(shapes).toEqual(['EVALSHA:deadbeef', 'LPUSH:2'].sort());
  });

  it('preserves the script SHA / function name for scripted shapes', () => {
    const baseline = new Set<string>();
    const result = computeNewShapes(captured, baseline);
    const eval_ = result.find((r) => r.cmd === 'EVALSHA')!;
    expect(eval_.scriptSha).toBe('deadbeef');
    expect(eval_.arity).toBeNull();
  });

  it('treats `VERB:*` from client-snapshots as covering all arities of that verb', () => {
    const baseline = new Set(['LPUSH:*', 'GET:*', 'EVALSHA:*']);
    const result = computeNewShapes(captured, baseline);
    expect(result).toEqual([]);
  });

  it('returns the captured shapes when baseline is empty (the spec edge case)', () => {
    const result = computeNewShapes(captured, new Set());
    const shapes = result.map((r) => r.shape).sort();
    expect(shapes).toEqual(['EVALSHA:deadbeef', 'GET:1', 'LPUSH:2'].sort());
  });

  it('sorts results by countInCapture descending', () => {
    const baseline = new Set<string>();
    const result = computeNewShapes(captured, baseline);
    const counts = result.map((r) => r.countInCapture);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

// ---------------------------------------------------------------------------
// computeHotKeyDelta
// ---------------------------------------------------------------------------

describe('computeHotKeyDelta', () => {
  it('flags keys present in capture top-K but absent from baseline top-K', () => {
    const captured = parseAll([
      '1700000000.0 [0 1.2.3.4:5] "GET" "user:42"',
      '1700000000.1 [0 1.2.3.4:5] "GET" "user:42"',
      '1700000000.2 [0 1.2.3.4:5] "GET" "user:42"',
      '1700000000.3 [0 1.2.3.4:5] "GET" "session:abc"',
    ]);
    const baselineKeys = new Map<string, number>([['user:42', 100]]);

    const result = computeHotKeyDelta(captured, baselineKeys);
    expect(result.newInTopK.map((k) => k.key)).toEqual(['session:abc']);
    expect(result.newInTopK[0]).toMatchObject({
      key: 'session:abc',
      countInCapture: 1,
      countInBaseline: 0,
      rankInBaseline: null,
    });
  });

  it('reports rank changes for keys present in both', () => {
    const captured = parseAll([
      // capture order: a (3), b (2), c (1)
      '1700000000.0 [0 x:1] "GET" "a"',
      '1700000000.0 [0 x:1] "GET" "a"',
      '1700000000.0 [0 x:1] "GET" "a"',
      '1700000000.0 [0 x:1] "GET" "b"',
      '1700000000.0 [0 x:1] "GET" "b"',
      '1700000000.0 [0 x:1] "GET" "c"',
    ]);
    // baseline order: c (10), b (5), a (1) → completely inverted
    const baselineKeys = new Map<string, number>([
      ['c', 10],
      ['b', 5],
      ['a', 1],
    ]);
    const result = computeHotKeyDelta(captured, baselineKeys);
    const byKey = new Map(result.rankChanges.map((r) => [r.key, r]));
    expect(byKey.get('a')).toMatchObject({ rankInCapture: 1, rankInBaseline: 3 });
    expect(byKey.get('c')).toMatchObject({ rankInCapture: 3, rankInBaseline: 1 });
    expect(result.newInTopK).toEqual([]);
  });

  it('returns empty deltas when no keyed commands appeared in the capture', () => {
    const captured = parseAll(['1700000000.0 [0 x:1] "PING"']);
    const result = computeHotKeyDelta(captured, new Map([['k', 100]]));
    expect(result.newInTopK).toEqual([]);
    expect(result.rankChanges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeSlowlogRegressions
// ---------------------------------------------------------------------------

function slowlogEntry(
  command: string[],
  capturedAtMs: number,
  id: number,
): StoredSlowLogEntry {
  return {
    id,
    timestamp: Math.floor(capturedAtMs / 1000),
    duration: 1000,
    command,
    clientAddress: '1.2.3.4:5',
    clientName: '',
    capturedAt: capturedAtMs,
    sourceHost: 'h',
    sourcePort: 6379,
    connectionId: CONNECTION_ID,
  };
}

describe('computeSlowlogRegressions', () => {
  const captured = parseAll([
    '1700000000.0 [0 1.2.3.4:5] "GET" "k"',
    '1700000000.1 [0 1.2.3.4:5] "SET" "k" "v"',
  ]);
  const baselineStart = SESSION_START_MS - 24 * 60 * 60 * 1000;
  const baselineEnd = SESSION_START_MS;

  it('flags verbs whose session-window rate exceeds the baseline p95', () => {
    // Baseline: GET is slow ~1/hour, SET never slow.
    const baseline: StoredSlowLogEntry[] = [
      ...Array.from({ length: 24 }, (_, i) =>
        slowlogEntry(['GET', 'x'], baselineStart + i * 60 * 60 * 1000, i),
      ),
    ];
    // Session window: GET slow 50 times in 5s → much higher than p95.
    const session: StoredSlowLogEntry[] = Array.from({ length: 50 }, (_, i) =>
      slowlogEntry(['GET', 'k'], SESSION_START_MS + i * 100, 1000 + i),
    );
    const result = computeSlowlogRegressions(
      captured,
      baseline,
      session,
      baselineStart,
      baselineEnd,
      SESSION_START_MS,
      SESSION_END_MS,
    );
    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({ cmd: 'GET', slowlogCountInSession: 50 });
    expect(result[0].observedRatePerSec).toBeGreaterThan(result[0].baselineP95RatePerSec);
  });

  it('returns empty when no captured verb appears in the session slowlog', () => {
    const baseline = [slowlogEntry(['GET', 'x'], baselineStart + 1000, 1)];
    const session: StoredSlowLogEntry[] = [];
    const result = computeSlowlogRegressions(
      captured,
      baseline,
      session,
      baselineStart,
      baselineEnd,
      SESSION_START_MS,
      SESSION_END_MS,
    );
    expect(result).toEqual([]);
  });

  it('handles the empty-baseline edge case (any session slowlog is a regression)', () => {
    const result = computeSlowlogRegressions(
      captured,
      [],
      [slowlogEntry(['GET', 'k'], SESSION_START_MS + 100, 1)],
      baselineStart,
      baselineEnd,
      SESSION_START_MS,
      SESSION_END_MS,
    );
    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({ cmd: 'GET', slowlogCountInSession: 1 });
    expect(result[0].baselineP95RatePerSec).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CrossReferenceEngine.compute — integration with mocked storage
// ---------------------------------------------------------------------------

function chunkOf(lines: string[]): StoredCaptureChunk {
  return {
    sessionId: SESSION_ID,
    chunkIndex: 0,
    bytes: Buffer.from(lines.join('\n'), 'utf-8'),
    lineCount: lines.length,
    firstTs: SESSION_START_MS,
    lastTs: SESSION_END_MS,
  };
}

function makeStorage(overrides: {
  session?: StoredCaptureSession | null;
  chunks?: StoredCaptureChunk[];
  slowlog?: StoredSlowLogEntry[];
  commandlog?: StoredCommandLogEntry[];
  clientSnapshots?: StoredClientSnapshot[];
  aclEntries?: StoredAclEntry[];
} = {}): StoragePort {
  const session: StoredCaptureSession =
    overrides.session ?? {
      id: SESSION_ID,
      connectionId: CONNECTION_ID,
      status: 'completed',
      source: 'manual',
      startedAt: SESSION_START_MS,
      endedAt: SESSION_END_MS,
      byteCount: 0,
      lineCount: 0,
      byteCap: 100_000,
      lineCap: 100_000,
    };

  const slowlog = overrides.slowlog ?? [];
  const slowlogInRange = (opts: { startTime?: number; endTime?: number } = {}) => {
    return slowlog.filter((e) => {
      if (opts.startTime !== undefined && e.timestamp < opts.startTime) return false;
      if (opts.endTime !== undefined && e.timestamp > opts.endTime) return false;
      return true;
    });
  };

  return {
    getCaptureSession: jest.fn().mockResolvedValue(overrides.session === null ? null : session),
    getCaptureChunks: jest.fn().mockResolvedValue(overrides.chunks ?? []),
    getSlowLogEntries: jest.fn().mockImplementation(async (opts) => slowlogInRange(opts ?? {})),
    getCommandLogEntries: jest.fn().mockResolvedValue(overrides.commandlog ?? []),
    getClientSnapshots: jest.fn().mockResolvedValue(overrides.clientSnapshots ?? []),
    getAclEntries: jest.fn().mockResolvedValue(overrides.aclEntries ?? []),
  } as unknown as StoragePort;
}

describe('CrossReferenceEngine.compute', () => {
  it('throws when the session does not exist', async () => {
    const engine = new CrossReferenceEngine(makeStorage({ session: null }));
    await expect(
      engine.compute({ sessionId: SESSION_ID, baseline: '24h' }),
    ).rejects.toThrow(`Session ${SESSION_ID} not found`);
  });

  it('end-to-end against the spec verification example', async () => {
    // Seed slowlog with shape GET:1
    const baselineStart = SESSION_START_MS - 24 * 60 * 60 * 1000;
    const slowlog: StoredSlowLogEntry[] = [
      slowlogEntry(['GET', 'foo'], baselineStart + 1000, 1),
    ];
    // Capture has GET foo and LPUSH x v
    const chunks = [chunkOf([
      '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
      '1700000000.5 [0 1.2.3.4:5] "LPUSH" "x" "v"',
    ])];
    const engine = new CrossReferenceEngine(makeStorage({ chunks, slowlog }));

    const result = await engine.compute({ sessionId: SESSION_ID, baseline: '24h' });
    expect(result.newShapes.map((s) => s.shape)).toEqual(['LPUSH:2']);
    expect(result.hotKeyDelta).toBeDefined();
    expect(result.slowlogRegressions).toBeDefined();
    expect(result.aclDeltas).toBeDefined();
    expect(result.baseline.window).toBe('24h');
    expect(result.session.startTs).toBe(SESSION_START_MS);
  });

  it('honors each of the four baseline windows', async () => {
    const engine = new CrossReferenceEngine(makeStorage());
    for (const window of ['6h', '24h', '7d', 'same-hour-last-week'] as const) {
      const result = await engine.compute({ sessionId: SESSION_ID, baseline: window });
      expect(result.baseline.window).toBe(window);
      expect(result.baseline.endTs).toBeGreaterThanOrEqual(result.baseline.startTs);
    }
  });

  it('treats a verb seen only in client-snapshots as covering all arities (no new shape)', async () => {
    const engine = new CrossReferenceEngine(
      makeStorage({
        chunks: [chunkOf(['1700000000.0 [0 1.2.3.4:5] "LPUSH" "x" "v"'])],
        clientSnapshots: [
          {
            id: 1,
            clientId: '1',
            addr: '1.2.3.4:5',
            name: '',
            user: 'default',
            db: 0,
            cmd: 'lpush', // lower-case verb in INFO
            age: 0,
            idle: 0,
            flags: '',
            sub: 0,
            psub: 0,
            qbuf: 0,
            qbufFree: 0,
            obl: 0,
            oll: 0,
            omem: 0,
            capturedAt: SESSION_START_MS - 1000,
            sourceHost: 'h',
            sourcePort: 6379,
            connectionId: CONNECTION_ID,
          },
        ],
      }),
    );
    const result = await engine.compute({ sessionId: SESSION_ID, baseline: '24h' });
    expect(result.newShapes).toEqual([]);
  });

  it('throws when the baseline session does not exist (capture-vs-capture)', async () => {
    const storage = {
      getCaptureSession: jest.fn().mockImplementation(async (id: string) => {
        return id === SESSION_ID
          ? {
              id: SESSION_ID,
              connectionId: CONNECTION_ID,
              status: 'completed',
              source: 'manual',
              startedAt: SESSION_START_MS,
              endedAt: SESSION_END_MS,
              byteCount: 0,
              lineCount: 1,
              byteCap: 100_000,
              lineCap: 100_000,
            }
          : null;
      }),
      getCaptureChunks: jest.fn().mockResolvedValue([]),
      getSlowLogEntries: jest.fn().mockResolvedValue([]),
      getCommandLogEntries: jest.fn().mockResolvedValue([]),
      getClientSnapshots: jest.fn().mockResolvedValue([]),
      getAclEntries: jest.fn().mockResolvedValue([]),
    } as unknown as StoragePort;
    const engine = new CrossReferenceEngine(storage);
    await expect(engine.computeCaptureDiff(SESSION_ID, 'missing')).rejects.toThrow(
      'Baseline session missing not found',
    );
  });

  it('refuses to diff a capture against itself', async () => {
    const engine = new CrossReferenceEngine(makeStorage());
    await expect(engine.computeCaptureDiff(SESSION_ID, SESSION_ID)).rejects.toThrow(
      /diff a capture against itself/,
    );
  });

  describe('capture-vs-capture diff', () => {
    const SESSION_B_ID = 'sess-other';
    const SESSION_B_START_MS = SESSION_START_MS - 60_000;
    const SESSION_B_END_MS = SESSION_B_START_MS + 30_000;

    function buildStorage(
      sessionALines: string[],
      sessionBLines: string[],
    ): StoragePort {
      const sessionA: StoredCaptureSession = {
        id: SESSION_ID,
        connectionId: CONNECTION_ID,
        status: 'completed',
        source: 'manual',
        startedAt: SESSION_START_MS,
        endedAt: SESSION_END_MS,
        byteCount: 0,
        lineCount: sessionALines.length,
        byteCap: 100_000,
        lineCap: 100_000,
      };
      const sessionB: StoredCaptureSession = {
        ...sessionA,
        id: SESSION_B_ID,
        startedAt: SESSION_B_START_MS,
        endedAt: SESSION_B_END_MS,
        lineCount: sessionBLines.length,
      };
      const chunksFor = (id: string) =>
        id === SESSION_ID
          ? [chunkOf(sessionALines)]
          : [{
              sessionId: SESSION_B_ID,
              chunkIndex: 0,
              bytes: Buffer.from(sessionBLines.join('\n'), 'utf-8'),
              lineCount: sessionBLines.length,
              firstTs: SESSION_B_START_MS,
              lastTs: SESSION_B_END_MS,
            }];
      return {
        getCaptureSession: jest.fn().mockImplementation(async (id: string) => {
          if (id === SESSION_ID) return sessionA;
          if (id === SESSION_B_ID) return sessionB;
          return null;
        }),
        getCaptureChunks: jest.fn().mockImplementation(async (id: string) => chunksFor(id)),
        getSlowLogEntries: jest.fn().mockResolvedValue([]),
        getCommandLogEntries: jest.fn().mockResolvedValue([]),
        getClientSnapshots: jest.fn().mockResolvedValue([]),
        getAclEntries: jest.fn().mockResolvedValue([]),
      } as unknown as StoragePort;
    }

    it('surfaces shapes in A that are absent from B as newShapes', async () => {
      const a = [
        '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
        '1700000000.5 [0 1.2.3.4:5] "LPUSH" "x" "v"',
      ];
      const b = [
        '1700000000.0 [0 1.2.3.4:5] "GET" "foo"',
      ];
      const engine = new CrossReferenceEngine(buildStorage(a, b));
      const result = await engine.computeCaptureDiff(SESSION_ID, SESSION_B_ID);
      expect(result.newShapes.map((s) => s.shape)).toEqual(['LPUSH:2']);
      expect(result.baseline.window).toBe('capture');
      expect(result.baseline.sessionId).toBe(SESSION_B_ID);
      expect(result.baseline.startTs).toBe(SESSION_B_START_MS);
      expect(result.baseline.endTs).toBe(SESSION_B_END_MS);
      expect(result.slowlogRegressions).toEqual([]);
      expect(result.aclDeltas.auditEntriesInWindow).toBe(0);
    });

    it('computes hot-key delta against the baseline capture key counts', async () => {
      const a = [
        '1700000000.0 [0 1.2.3.4:5] "GET" "k1"',
        '1700000000.1 [0 1.2.3.4:5] "GET" "k1"',
        '1700000000.2 [0 1.2.3.4:5] "GET" "k2"',
      ];
      const b = [
        '1700000000.0 [0 1.2.3.4:5] "GET" "k1"',
      ];
      const engine = new CrossReferenceEngine(buildStorage(a, b));
      const result = await engine.computeCaptureDiff(SESSION_ID, SESSION_B_ID);
      const keysInResult = [
        ...result.hotKeyDelta.newInTopK.map((k) => k.key),
        ...result.hotKeyDelta.rankChanges.map((k) => k.key),
      ];
      expect(keysInResult).toContain('k2');
    });
  });

  it('surfaces audit-trail entry count in aclDeltas when audit module persists rows in the window', async () => {
    const aclEntries: StoredAclEntry[] = [
      {
        id: 1,
        count: 1,
        reason: 'invalid-password',
        context: 'connection',
        object: '',
        username: 'attacker',
        ageSeconds: 0,
        clientInfo: '1.2.3.4:5',
        timestampCreated: SESSION_START_MS + 1000,
        timestampLastUpdated: SESSION_START_MS + 1000,
        capturedAt: SESSION_START_MS + 1000,
        sourceHost: 'h',
        sourcePort: 6379,
        connectionId: CONNECTION_ID,
      } as unknown as StoredAclEntry,
    ];
    const engine = new CrossReferenceEngine(makeStorage({ aclEntries }));
    const result = await engine.compute({ sessionId: SESSION_ID, baseline: '24h' });
    expect(result.aclDeltas.auditEntriesInWindow).toBe(1);
    expect(result.aclDeltas.counters.aclAccessDeniedAuthDelta).toBeNull();
  });
});
