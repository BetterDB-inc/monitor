import { describe, it, expect } from 'vitest';
import { computeDepths } from './AiTraces';
import type { StoredOtelSpan } from '@betterdb/shared';

function span(spanId: string, parentSpanId: string | null): StoredOtelSpan {
  return {
    traceId: 't',
    spanId,
    parentSpanId,
    name: spanId,
    scopeName: '@betterdb/agent-cache',
    serviceName: null,
    kind: 1,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    startTimeMs: 0,
    durationNs: 0,
    statusCode: 0,
    statusMessage: null,
    attributes: '{}',
    ingestedAt: 0,
  };
}

describe('computeDepths', () => {
  it('nests spans by their parent chain', () => {
    const d = computeDepths([span('root', null), span('a', 'root'), span('b', 'a')]);
    expect(d.get('root')).toBe(0);
    expect(d.get('a')).toBe(1);
    expect(d.get('b')).toBe(2);
  });

  it('nests spans whose parent was dropped (not stored) under the root, not at depth 0', () => {
    // Ingest keeps only @betterdb spans + the root, so `orphan`'s parent is absent.
    const d = computeDepths([span('root', null), span('orphan', 'missing-parent')]);
    expect(d.get('root')).toBe(0);
    expect(d.get('orphan')).toBe(1); // would be 0 (aligned with root) before the fix
  });

  it('does not infinite-loop on a parent cycle', () => {
    const d = computeDepths([span('x', 'y'), span('y', 'x')]);
    expect(d.get('x')).toBeGreaterThanOrEqual(0);
    expect(d.get('y')).toBeGreaterThanOrEqual(0);
  });
});
