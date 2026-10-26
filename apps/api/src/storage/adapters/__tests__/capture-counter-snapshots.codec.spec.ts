import type { CaptureCounterSnapshots } from '@betterdb/shared';
import {
  decodeCounterSnapshots,
  encodeCounterSnapshots,
} from '../capture-counter-snapshots.codec';

const SNAPSHOTS: CaptureCounterSnapshots = {
  version: 1,
  nodes: [
    {
      nodeId: 'A',
      address: 'h1:6379',
      start: { capturedAt: 1, counters: { keyspace_hits: 5, evicted_keys: 0 } },
      end: { capturedAt: 2, counters: { keyspace_hits: 9, evicted_keys: 1 } },
    },
    { start: null, end: null, startError: 'timeout', endError: 'no_end_sample' },
  ],
};

describe('capture counter snapshots codec', () => {
  it('encodes undefined as null', () => {
    expect(encodeCounterSnapshots(undefined)).toBeNull();
  });

  it('round-trips through a JSON string', () => {
    const encoded = encodeCounterSnapshots(SNAPSHOTS);
    expect(typeof encoded).toBe('string');
    expect(decodeCounterSnapshots(encoded)).toEqual(SNAPSHOTS);
  });

  it('accepts an already-parsed value (pg JSONB)', () => {
    expect(decodeCounterSnapshots(JSON.parse(JSON.stringify(SNAPSHOTS)))).toEqual(SNAPSHOTS);
  });

  it('decodes null and undefined to undefined', () => {
    expect(decodeCounterSnapshots(null)).toBeUndefined();
    expect(decodeCounterSnapshots(undefined)).toBeUndefined();
  });

  it('decodes invalid JSON to undefined', () => {
    expect(decodeCounterSnapshots('{bad')).toBeUndefined();
  });

  it('decodes a wrong version to undefined', () => {
    expect(decodeCounterSnapshots({ version: 2, nodes: [] })).toBeUndefined();
  });

  it('decodes a non-array nodes field to undefined', () => {
    expect(decodeCounterSnapshots({ version: 1, nodes: {} })).toBeUndefined();
  });

  it('decodes a non-object node to undefined', () => {
    expect(decodeCounterSnapshots({ version: 1, nodes: ['x'] })).toBeUndefined();
  });

  it('treats a sample with a non-finite capturedAt as missing', () => {
    const decoded = decodeCounterSnapshots({
      version: 1,
      nodes: [
        { start: { capturedAt: 'soon', counters: {} }, end: { capturedAt: 2, counters: {} } },
      ],
    });
    expect(decoded?.nodes[0].start).toBeNull();
    expect(decoded?.nodes[0].end).toEqual({ capturedAt: 2, counters: {} });
  });

  it('drops unknown counter names, negatives and strings', () => {
    const decoded = decodeCounterSnapshots({
      version: 1,
      nodes: [
        {
          start: {
            capturedAt: 1,
            counters: { keyspace_hits: 3, bogus: 1, expired_keys: -1, evicted_keys: '4' },
          },
          end: null,
        },
      ],
    });
    expect(decoded?.nodes[0].start?.counters).toEqual({ keyspace_hits: 3 });
  });

  it('keeps optional string fields and drops non-string ones', () => {
    const decoded = decodeCounterSnapshots({
      version: 1,
      nodes: [
        { nodeId: 'A', address: 7, startError: 'e', endError: false, start: null, end: null },
      ],
    });
    expect(decoded?.nodes[0]).toEqual({ nodeId: 'A', startError: 'e', start: null, end: null });
  });
});
