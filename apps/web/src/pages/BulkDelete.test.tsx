import { describe, expect, it } from 'vitest';
import { jobCardVisible, requestSignature } from './BulkDelete';
import type { BulkDeleteRequest } from '../api/bulkDelete';

const job = (status: 'running' | 'completed') => ({ status }) as any;

describe('requestSignature', () => {
  const base: BulkDeleteRequest = { match: 'a:*', scope: 'node' };

  it('ignores batching/pacing knobs (count, batchPauseMs, confirmDeleteAll)', () => {
    const sig = requestSignature(base);
    expect(requestSignature({ ...base, count: 999 })).toBe(sig);
    expect(requestSignature({ ...base, batchPauseMs: 500 })).toBe(sig);
    expect(requestSignature({ ...base, confirmDeleteAll: true })).toBe(sig);
  });

  it('changes when match, type, scope, or maxKeys change', () => {
    const sig = requestSignature(base);
    expect(requestSignature({ ...base, match: 'b:*' })).not.toBe(sig);
    expect(requestSignature({ ...base, type: 'hash' })).not.toBe(sig);
    expect(requestSignature({ ...base, scope: 'cluster' })).not.toBe(sig);
    expect(requestSignature({ ...base, maxKeys: 100 })).not.toBe(sig);
  });
});

describe('jobCardVisible', () => {
  it('always shows a running job, even when the target is stale (mid-run edit)', () => {
    // Regression: editing the target mid-run must not hide a running job's card
    // (its live progress and Cancel control must stay reachable).
    expect(jobCardVisible(job('running'), true)).toBe(true);
    expect(jobCardVisible(job('running'), false)).toBe(true);
  });

  it('hides a finished job once the target has changed (preview or execute)', () => {
    expect(jobCardVisible(job('completed'), true)).toBe(false);
    expect(jobCardVisible(job('completed'), false)).toBe(true);
  });

  it('returns false when there is no job', () => {
    expect(jobCardVisible(null, false)).toBe(false);
    expect(jobCardVisible(undefined, true)).toBe(false);
  });
});
