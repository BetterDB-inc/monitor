import type { CaptureCounterSample, CaptureCounterSnapshots } from '@betterdb/shared';
import { CAPTURE_COUNTER_FIELDS } from '@betterdb/shared';
import {
  NO_END_SAMPLE,
  buildStartSnapshots,
  computeCounterDeltas,
  counterNodeKey,
  deriveCounterRates,
  extractCaptureCounters,
  readCounterSample,
  sampleFromInfoText,
  withEndSamples,
} from '../capture-counters';

const INFO_STATS = [
  '# Stats',
  'total_connections_received:10',
  'total_commands_processed:1000',
  'instantaneous_ops_per_sec:5',
  'rejected_connections:2',
  'keyspace_hits:80',
  'keyspace_misses:20',
  'expired_keys:3',
  'evicted_keys:0',
  'total_net_input_bytes:4096',
  'total_net_output_bytes:8192',
  'total_error_replies:1',
  'acl_access_denied_auth:4',
  'sync_full:0',
  '',
].join('\r\n');

function sample(
  capturedAt: number,
  counters: CaptureCounterSample['counters'],
): CaptureCounterSample {
  return { capturedAt, counters };
}

describe('extractCaptureCounters / sampleFromInfoText', () => {
  it('extracts only the monotonic fields the server reported', () => {
    const s = sampleFromInfoText(INFO_STATS, 123);
    expect(s.capturedAt).toBe(123);
    expect(s.counters).toEqual({
      total_connections_received: 10,
      total_commands_processed: 1000,
      rejected_connections: 2,
      keyspace_hits: 80,
      keyspace_misses: 20,
      expired_keys: 3,
      evicted_keys: 0,
      total_net_input_bytes: 4096,
      total_error_replies: 1,
      acl_access_denied_auth: 4,
      sync_full: 0,
    });
    expect(s.counters).not.toHaveProperty('instantaneous_ops_per_sec');
    expect(s.counters).not.toHaveProperty('total_net_output_bytes');
  });

  it('leaves fields an older server does not emit absent rather than 0', () => {
    const s = sampleFromInfoText('# Stats\r\ntotal_commands_processed:5\r\n', 1);
    expect(s.counters).toEqual({ total_commands_processed: 5 });
    expect(s.counters.total_error_replies).toBeUndefined();
  });

  it('returns no counters when the stats section is missing', () => {
    expect(extractCaptureCounters({ server: { redis_version: '7.2.0' } })).toEqual({});
  });

  it('skips non-numeric, blank and negative values', () => {
    expect(
      extractCaptureCounters({
        stats: { keyspace_hits: 'abc', keyspace_misses: '', expired_keys: '-1', evicted_keys: '7' },
      }),
    ).toEqual({ evicted_keys: 7 });
  });

  it('declares 16 counter fields', () => {
    expect(CAPTURE_COUNTER_FIELDS).toHaveLength(16);
  });
});

describe('readCounterSample', () => {
  it('returns the sample on success and forwards connection/node ids', async () => {
    const reader = jest.fn().mockResolvedValue(sample(1, { keyspace_hits: 1 }));
    await expect(readCounterSample(reader, 'conn', 'node-a')).resolves.toEqual({
      sample: sample(1, { keyspace_hits: 1 }),
    });
    expect(reader).toHaveBeenCalledWith('conn', 'node-a');
  });

  it('converts a rejection into an error outcome', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(readCounterSample(reader, 'conn')).resolves.toEqual({
      sample: null,
      error: 'ECONNREFUSED',
    });
  });

  it('converts a synchronous throw into an error outcome', async () => {
    const reader = jest.fn(() => {
      throw new TypeError('no client');
    });
    await expect(readCounterSample(reader as never, 'conn')).resolves.toEqual({
      sample: null,
      error: 'no client',
    });
  });

  it('times out a hung reader', async () => {
    const reader = jest.fn(() => new Promise<CaptureCounterSample>(() => undefined));
    await expect(readCounterSample(reader, 'conn', undefined, 20)).resolves.toEqual({
      sample: null,
      error: 'INFO stats timed out after 20 ms',
    });
  });

  it('truncates very long error messages to 200 chars plus an ellipsis', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('x'.repeat(500)));
    const outcome = await readCounterSample(reader, 'conn');
    expect(outcome.error).toHaveLength(201);
  });
});

describe('buildStartSnapshots / withEndSamples', () => {
  it('builds a single-node snapshot without nodeId', () => {
    const snaps = buildStartSnapshots([{ outcome: { sample: sample(1, {}) } }]);
    expect(snaps).toEqual({ version: 1, nodes: [{ start: sample(1, {}), end: null }] });
  });

  it('records startError and node identity', () => {
    const snaps = buildStartSnapshots([
      { nodeId: 'A', address: 'h1:6379', outcome: { sample: null, error: 'timeout' } },
    ]);
    expect(snaps.nodes[0]).toEqual({
      nodeId: 'A',
      address: 'h1:6379',
      start: null,
      end: null,
      startError: 'timeout',
    });
  });

  it('attaches end samples by node key and marks missing ones', () => {
    const snaps = buildStartSnapshots([
      { nodeId: 'A', outcome: { sample: sample(1, {}) } },
      { nodeId: 'B', outcome: { sample: sample(1, {}) } },
    ]);
    const done = withEndSamples(
      snaps,
      new Map([[counterNodeKey('A'), { sample: sample(2, {}) }]]),
    );
    expect(done?.nodes[0].end).toEqual(sample(2, {}));
    expect(done?.nodes[0].endError).toBeUndefined();
    expect(done?.nodes[1]).toMatchObject({ end: null, endError: NO_END_SAMPLE });
  });

  it('keys the single-node entry by the empty string', () => {
    const snaps = buildStartSnapshots([{ outcome: { sample: sample(1, {}) } }]);
    const done = withEndSamples(
      snaps,
      new Map([[counterNodeKey(undefined), { sample: null, error: 'boom' }]]),
    );
    expect(done?.nodes[0]).toMatchObject({ end: null, endError: 'boom' });
  });

  it('returns undefined when there were no start snapshots', () => {
    expect(withEndSamples(undefined, new Map())).toBeUndefined();
  });
});

describe('computeCounterDeltas', () => {
  const START = 1_700_000_000_000;

  function snaps(nodes: CaptureCounterSnapshots['nodes']): CaptureCounterSnapshots {
    return { version: 1, nodes };
  }

  it('is unavailable (all null) for legacy sessions', () => {
    const d = computeCounterDeltas(undefined);
    expect(d.coverage).toBe('unavailable');
    expect(d.nodesTotal).toBe(0);
    expect(d.windowMs).toBeNull();
    expect(Object.values(d.deltas).every((v) => v === null)).toBe(true);
    expect(d.derived).toEqual({ commandsPerSec: null, keyspaceHitRatio: null });
  });

  it('computes single-node deltas and derived rates', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          start: sample(START, {
            total_commands_processed: 1000,
            keyspace_hits: 80,
            keyspace_misses: 20,
            rejected_connections: 2,
            acl_access_denied_auth: 4,
          }),
          end: sample(START + 10_000, {
            total_commands_processed: 3000,
            keyspace_hits: 170,
            keyspace_misses: 30,
            rejected_connections: 5,
            acl_access_denied_auth: 4,
          }),
        },
      ]),
    );
    expect(d.coverage).toBe('complete');
    expect(d.windowMs).toBe(10_000);
    expect(d.deltas.total_commands_processed).toBe(2000);
    expect(d.deltas.rejected_connections).toBe(3);
    expect(d.deltas.acl_access_denied_auth).toBe(0);
    expect(d.deltas.evicted_keys).toBeNull();
    expect(d.derived.commandsPerSec).toBe(200);
    expect(d.derived.keyspaceHitRatio).toBeCloseTo(0.9);
  });

  it('sums across fan-out nodes and uses the longest window', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          start: sample(START, { evicted_keys: 1 }),
          end: sample(START + 5_000, { evicted_keys: 4 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { evicted_keys: 0 }),
          end: sample(START + 6_000, { evicted_keys: 2 }),
        },
      ]),
    );
    expect(d.nodesMeasured).toBe(2);
    expect(d.deltas.evicted_keys).toBe(5);
    expect(d.windowMs).toBe(6_000);
  });

  it('is partial when a node lacks a sample', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          start: sample(START, { sync_full: 0 }),
          end: sample(START + 1, { sync_full: 1 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { sync_full: 0 }),
          end: null,
          endError: 'no_end_sample',
        },
      ]),
    );
    expect(d.coverage).toBe('partial');
    expect(d.nodesMeasured).toBe(1);
    expect(d.nodesTotal).toBe(2);
    expect(d.deltas.sync_full).toBe(1);
  });

  it('excludes the whole node when any counter went backwards (CONFIG RESETSTAT)', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          address: 'h1:6379',
          start: sample(START, { keyspace_hits: 100, keyspace_misses: 5, rejected_connections: 0 }),
          end: sample(START + 1_000, {
            keyspace_hits: 3,
            keyspace_misses: 9,
            rejected_connections: 0,
          }),
        },
        {
          nodeId: 'B',
          start: sample(START, { keyspace_hits: 10, keyspace_misses: 0, rejected_connections: 1 }),
          end: sample(START + 1_000, {
            keyspace_hits: 15,
            keyspace_misses: 5,
            rejected_connections: 1,
          }),
        },
      ]),
    );
    expect(d.coverage).toBe('partial');
    expect(d.nodesMeasured).toBe(1);
    expect(d.resets).toEqual([
      { node: 'h1:6379', reason: 'counter_reset', counters: ['keyspace_hits'] },
    ]);
    // A's misses (+4) and its flat rejected_connections are not summed either.
    expect(d.deltas.keyspace_hits).toBe(5);
    expect(d.deltas.keyspace_misses).toBe(5);
    expect(d.deltas.rejected_connections).toBe(0);
    expect(d.derived.keyspaceHitRatio).toBeCloseTo(0.5);
  });

  it('ignores a node whose end sample predates its start (clock skew)', () => {
    const d = computeCounterDeltas(
      snaps([{ start: sample(START, {}), end: sample(START - 1, {}) }]),
    );
    expect(d.coverage).toBe('unavailable');
  });

  it('is unavailable when every start sample failed', () => {
    const d = computeCounterDeltas(
      snaps([{ start: null, end: sample(START, {}), startError: 'timeout' }]),
    );
    expect(d.coverage).toBe('unavailable');
    expect(d.nodesTotal).toBe(1);
  });
});

describe('deriveCounterRates', () => {
  it('returns null rates for a zero-length window or zero lookups', () => {
    const deltas = computeCounterDeltas(undefined).deltas;
    deltas.total_commands_processed = 10;
    deltas.keyspace_hits = 0;
    deltas.keyspace_misses = 0;
    expect(deriveCounterRates(deltas, 0)).toEqual({ commandsPerSec: null, keyspaceHitRatio: null });
  });
});

describe('computeCounterDeltas restart detection', () => {
  const START = 1_700_000_000_000;
  function node(
    start: CaptureCounterSample | null,
    end: CaptureCounterSample | null,
    extra: Partial<CaptureCounterSnapshots['nodes'][number]> = {},
  ): CaptureCounterSnapshots['nodes'][number] {
    return { start, end, ...extra };
  }
  function snaps(nodes: CaptureCounterSnapshots['nodes']): CaptureCounterSnapshots {
    return { version: 1, nodes };
  }

  it('detects a restart by run_id even when every counter climbed back past its start value', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          {
            capturedAt: START,
            counters: { total_commands_processed: 100, rejected_connections: 0 },
            runId: 'aaa',
            uptimeSec: 500,
          },
          {
            capturedAt: START + 600_000,
            counters: { total_commands_processed: 900, rejected_connections: 0 },
            runId: 'bbb',
            uptimeSec: 300,
          },
          { address: 'h1:6379' },
        ),
      ]),
    );
    expect(d.coverage).toBe('unavailable');
    expect(d.nodesMeasured).toBe(0);
    expect(d.resets).toEqual([{ node: 'h1:6379', reason: 'restart', counters: [] }]);
    expect(d.deltas.total_commands_processed).toBeNull();
    expect(d.deltas.rejected_connections).toBeNull();
  });

  it('detects a restart by uptime when run_id is not reported', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { total_commands_processed: 100 }, uptimeSec: 5_000 },
          {
            capturedAt: START + 60_000,
            counters: { total_commands_processed: 200 },
            uptimeSec: 30,
          },
        ),
      ]),
    );
    expect(d.resets).toEqual([{ node: 'instance', reason: 'restart', counters: [] }]);
    expect(d.coverage).toBe('unavailable');
  });

  it('detects a restart when only the end uptime is known and it is shorter than the window', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { total_commands_processed: 100 } },
          {
            capturedAt: START + 60_000,
            counters: { total_commands_processed: 200 },
            uptimeSec: 10,
          },
        ),
      ]),
    );
    expect(d.resets[0]?.reason).toBe('restart');
  });

  it('does not flag a restart for a steady process', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          {
            capturedAt: START,
            counters: { total_commands_processed: 100 },
            runId: 'aaa',
            uptimeSec: 500,
          },
          {
            capturedAt: START + 10_000,
            counters: { total_commands_processed: 200 },
            runId: 'aaa',
            uptimeSec: 510,
          },
        ),
      ]),
    );
    expect(d.coverage).toBe('complete');
    expect(d.resets).toEqual([]);
    expect(d.deltas.total_commands_processed).toBe(100);
  });

  it('detects a restart whose end uptime is still higher than the start uptime', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { total_commands_processed: 100 }, uptimeSec: 1_000 },
          {
            capturedAt: START + 3_600_000,
            counters: { total_commands_processed: 500 },
            uptimeSec: 3_000,
          },
        ),
      ]),
    );
    expect(d.resets[0]?.reason).toBe('restart');
    expect(d.coverage).toBe('unavailable');
  });

  it('does not flag a steady one-hour capture by uptime', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { total_commands_processed: 100 }, uptimeSec: 1_000 },
          {
            capturedAt: START + 3_600_000,
            counters: { total_commands_processed: 500 },
            uptimeSec: 4_600,
          },
        ),
      ]),
    );
    expect(d.resets).toEqual([]);
    expect(d.coverage).toBe('complete');
  });

  it('does not flag uptime jitter within the slack', () => {
    const slackSec = 2; // mirrors UPTIME_SLACK_SEC in capture-counters.ts
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { total_commands_processed: 100 }, uptimeSec: 1_000 },
          {
            capturedAt: START + 3_600_000,
            counters: { total_commands_processed: 500 },
            uptimeSec: 1_000 + 3_600 - (slackSec - 1),
          },
        ),
      ]),
    );
    expect(d.resets).toEqual([]);
    expect(d.coverage).toBe('complete');
  });

  it('keeps summing the other nodes when one restarts', () => {
    const d = computeCounterDeltas(
      snaps([
        node(
          { capturedAt: START, counters: { evicted_keys: 1 }, runId: 'a1' },
          { capturedAt: START + 5_000, counters: { evicted_keys: 9 }, runId: 'a2' },
          { nodeId: 'A' },
        ),
        node(
          { capturedAt: START, counters: { evicted_keys: 0 }, runId: 'b1' },
          { capturedAt: START + 5_000, counters: { evicted_keys: 2 }, runId: 'b1' },
          { nodeId: 'B' },
        ),
      ]),
    );
    expect(d.coverage).toBe('partial');
    expect(d.nodesMeasured).toBe(1);
    expect(d.deltas.evicted_keys).toBe(2);
    expect(d.resets).toEqual([{ node: 'A', reason: 'restart', counters: [] }]);
  });
});

describe('computeCounterDeltas per-field coverage', () => {
  const START = 1_700_000_000_000;
  function snaps(nodes: CaptureCounterSnapshots['nodes']): CaptureCounterSnapshots {
    return { version: 1, nodes };
  }

  it('is partial and lists the counter when a field is present on some nodes but not others', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          start: sample(START, { total_commands_processed: 10, total_error_replies: 1 }),
          end: sample(START + 1_000, { total_commands_processed: 20, total_error_replies: 4 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { total_commands_processed: 5 }),
          end: sample(START + 1_000, { total_commands_processed: 8 }),
        },
      ]),
    );
    expect(d.coverage).toBe('partial');
    expect(d.nodesMeasured).toBe(2);
    expect(d.incompleteCounters).toEqual(['total_error_replies']);
    expect(d.deltas.total_error_replies).toBe(3);
    expect(d.deltas.total_commands_processed).toBe(13);
  });

  it('is complete when no measured node reports a field at all', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          start: sample(START, { keyspace_hits: 1 }),
          end: sample(START + 1, { keyspace_hits: 2 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { keyspace_hits: 1 }),
          end: sample(START + 1, { keyspace_hits: 3 }),
        },
      ]),
    );
    expect(d.coverage).toBe('complete');
    expect(d.incompleteCounters).toEqual([]);
    expect(d.deltas.total_error_replies).toBeNull();
  });

  it('computes the hit ratio only over nodes that report both hits and misses', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          start: sample(START, { keyspace_hits: 0, keyspace_misses: 0 }),
          end: sample(START + 1, { keyspace_hits: 9, keyspace_misses: 1 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { keyspace_hits: 0 }),
          end: sample(START + 1, { keyspace_hits: 90 }),
        },
      ]),
    );
    expect(d.deltas.keyspace_hits).toBe(99);
    expect(d.derived.keyspaceHitRatio).toBeCloseTo(0.9);
  });

  it('passes the pending marker through and leaves it unset otherwise', () => {
    expect(computeCounterDeltas(undefined, 'capture_running').pending).toBe('capture_running');
    expect(computeCounterDeltas(undefined, 'capture_interrupted').pending).toBe(
      'capture_interrupted',
    );
    expect(computeCounterDeltas(undefined)).not.toHaveProperty('pending');
  });
});

describe('sampleFromInfoText process identity', () => {
  it('reads run_id and uptime_in_seconds from # Server alongside # Stats', () => {
    const text = ['# Server', 'run_id:abc123', 'uptime_in_seconds:42', '', INFO_STATS].join('\r\n');
    const s = sampleFromInfoText(text, 7);
    expect(s.runId).toBe('abc123');
    expect(s.uptimeSec).toBe(42);
    expect(s.counters.total_commands_processed).toBe(1000);
  });

  it('omits identity when # Server is absent', () => {
    const s = sampleFromInfoText(INFO_STATS, 7);
    expect(s).not.toHaveProperty('runId');
    expect(s).not.toHaveProperty('uptimeSec');
  });
});
