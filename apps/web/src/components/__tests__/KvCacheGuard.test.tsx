import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Feature } from '@betterdb/shared';

const { license, refreshFootprint, getStatus } = vi.hoisted(() => ({
  license: { licensed: true },
  refreshFootprint: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({
    hasFeature: (feature: string) => license.licensed && feature === Feature.KV_CACHE_MONITORING,
  }),
}));
vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
}));
vi.mock('../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { getStatus, refreshFootprint } };
});

import { KvCacheGuard } from '../KvCacheGuard';

function renderGuard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <KvCacheGuard>
          <div data-testid="children" />
        </KvCacheGuard>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const latest = {
  connectionId: 'c1',
  timestamp: 1,
  detected: false,
  layout: null,
  scannedKeys: 1200,
  matchedKeys: 2,
  sampledKeys: 0,
  scanComplete: true,
  chunksEst: 0,
  bytesEst: 0,
  usedMemory: 0,
  maxmemory: 0,
  maxmemoryPolicy: 'noeviction',
  lmcacheMemoryShare: 0,
  noTtlRatio: 0,
  orphanRatio: null,
  evictedKeysDelta: null,
  otherDbs: [3, 5],
  perModel: [],
};

describe('KvCacheGuard', () => {
  beforeEach(() => {
    license.licensed = true;
    getStatus.mockReset();
    refreshFootprint.mockReset();
    refreshFootprint.mockResolvedValue(null);
  });

  it('shows the upgrade prompt and no children when unlicensed', () => {
    license.licensed = false;
    renderGuard();
    expect(screen.getByText(/Upgrade to Pro/i)).toBeInTheDocument();
    expect(screen.queryByTestId('children')).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('shows the key shape and rescans when LMCache is not detected', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    renderGuard();
    expect(
      await screen.findByText('Qwen/Qwen2.5-0.5B-Instruct@1@0@9e3779b97f4a7c15@bfloat16'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Other databases with keys: db3, db5/)).toBeInTheDocument();
    expect(screen.queryByTestId('children')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan now' }));
    await waitFor(() => expect(refreshFootprint).toHaveBeenCalledTimes(1));
  });

  it('keeps rendering children when a background refetch fails', async () => {
    getStatus.mockResolvedValueOnce({ hasLmcache: true, latest, sampleKey: null, engines: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <KvCacheGuard>
            <div data-testid="children" />
          </KvCacheGuard>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('children')).toBeInTheDocument();
    getStatus.mockRejectedValue(new Error('boom'));
    await client.refetchQueries({ queryKey: ['kv-cache', 'status'] });
    await waitFor(() =>
      expect(client.getQueryState(['kv-cache', 'status', 'c1'])?.status).toBe('error'),
    );
    expect(screen.getByTestId('children')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load KV cache status/)).toBeNull();
  });

  it('shows the error state when the first load fails', async () => {
    getStatus.mockRejectedValue(new Error('boom'));
    renderGuard();
    expect(await screen.findByText(/Could not load KV cache status/)).toBeInTheDocument();
  });

  it('renders children when LMCache is detected', async () => {
    getStatus.mockResolvedValue({ hasLmcache: true, latest, sampleKey: null, engines: [] });
    renderGuard();
    expect(await screen.findByTestId('children')).toBeInTheDocument();
  });
});
