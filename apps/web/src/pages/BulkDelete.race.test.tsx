import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BulkDelete } from './BulkDelete';
import { bulkDeleteApi, type BulkDeleteJob } from '../api/bulkDelete';

vi.mock('../api/bulkDelete', () => ({
  bulkDeleteApi: {
    preview: vi.fn(),
    execute: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    getAudits: vi.fn(async () => []),
  },
}));

const api = bulkDeleteApi as unknown as {
  preview: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  getAudits: ReturnType<typeof vi.fn>;
};

const completedDryRun = (match: string): BulkDeleteJob => ({
  id: 'job1',
  connectionId: 'c',
  mode: 'dry-run',
  scope: 'node',
  status: 'completed',
  match,
  type: null,
  startedAt: 0,
  completedAt: 1,
  error: null,
  matched: 5,
  deleted: 0,
  batches: 1,
  nodesTotal: 1,
  nodesDone: 1,
  truncated: false,
  cancelled: false,
  sampleKeys: [`${match.replace('*', '')}1`],
  perNode: [],
  skipped: [],
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BulkDelete />
    </QueryClientProvider>,
  );
}

describe('BulkDelete preview staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAudits.mockResolvedValue([]);
  });

  it('shows the preview card when the target is unchanged', async () => {
    api.preview.mockResolvedValue({ jobId: 'job1', status: 'running' });
    api.getJob.mockResolvedValue(completedDryRun('old:*'));

    renderPage();
    fireEvent.change(screen.getByPlaceholderText('session:*'), { target: { value: 'old:*' } });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // The finished dry-run for the current target is shown.
    expect(await screen.findByText(/matching "old:\*"/i)).toBeTruthy();
  });

  it('does not show a preview for a target edited while the request was in flight', async () => {
    // Hold the preview response so we can edit the form before the job id returns.
    let resolvePreview!: (v: { jobId: string; status: string }) => void;
    api.preview.mockImplementation(
      () => new Promise((r) => (resolvePreview = r as typeof resolvePreview)),
    );
    api.getJob.mockResolvedValue(completedDryRun('old:*')); // the job scanned old:*

    renderPage();
    const matchInput = screen.getByPlaceholderText('session:*');
    fireEvent.change(matchInput, { target: { value: 'old:*' } });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // The request is built at click time (old:*); wait until it is actually sent.
    await waitFor(() => expect(api.preview).toHaveBeenCalled());

    // Edit the target while the preview request is still in flight.
    fireEvent.change(matchInput, { target: { value: 'new:*' } });

    // Now the id returns and the (old:*) job completes.
    resolvePreview({ jobId: 'job1', status: 'running' });
    await waitFor(() => expect(api.getJob).toHaveBeenCalled());

    // Give the (stale) preview card up to 500ms to appear — it must not. The
    // job scanned old:* but the form now shows new:*, so neither may be shown.
    await expect(
      screen.findByText(/matching "(old|new):\*"/i, {}, { timeout: 500 }),
    ).rejects.toThrow();
  });
});
