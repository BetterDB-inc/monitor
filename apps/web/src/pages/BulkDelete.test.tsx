import { describe, expect, it } from 'vitest';
import { showPreviewCard } from './BulkDelete';

const job = (mode: 'dry-run' | 'execute', status: 'running' | 'completed') =>
  ({ mode, status }) as any;

describe('showPreviewCard', () => {
  it('always shows a running preview, even when the target is stale (mid-run edit)', () => {
    // Regression: editing the target mid-run must not hide the running preview
    // (its live progress and Cancel control must stay reachable).
    expect(showPreviewCard(job('dry-run', 'running'), true)).toBe(true);
    expect(showPreviewCard(job('dry-run', 'running'), false)).toBe(true);
  });

  it('hides a finished preview once the target has changed', () => {
    expect(showPreviewCard(job('dry-run', 'completed'), true)).toBe(false);
    expect(showPreviewCard(job('dry-run', 'completed'), false)).toBe(true);
  });

  it('never renders as a preview for execute jobs or no job', () => {
    expect(showPreviewCard(job('execute', 'running'), false)).toBe(false);
    expect(showPreviewCard(null, false)).toBe(false);
    expect(showPreviewCard(undefined, true)).toBe(false);
  });
});
