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
      total_net_output_bytes: 8192,
      total_error_replies: 1,
      acl_access_denied_auth: 4,
      sync_full: 0,
    });
    expect(s.counters).not.toHaveProperty('instantaneous_ops_per_sec');
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

  it('declares 17 counter fields', () => {
    expect(CAPTURE_COUNTER_FIELDS).toHaveLength(17);
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

  it('excludes and reports a counter that went backwards on one node', () => {
    const d = computeCounterDeltas(
      snaps([
        {
          nodeId: 'A',
          address: 'h1:6379',
          start: sample(START, { keyspace_hits: 100, keyspace_misses: 5 }),
          end: sample(START + 1_000, { keyspace_hits: 3, keyspace_misses: 9 }),
        },
        {
          nodeId: 'B',
          start: sample(START, { keyspace_hits: 10 }),
          end: sample(START + 1_000, { keyspace_hits: 15 }),
        },
      ]),
    );
    expect(d.coverage).toBe('partial');
    expect(d.resets).toEqual([{ node: 'h1:6379', counters: ['keyspace_hits'] }]);
    expect(d.deltas.keyspace_hits).toBe(5);
    expect(d.deltas.keyspace_misses).toBe(4);
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
