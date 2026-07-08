import { describe, expect, it } from 'vitest';
import { jobCardVisible } from './BulkDelete';

const job = (status: 'running' | 'completed') => ({ status }) as any;

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
