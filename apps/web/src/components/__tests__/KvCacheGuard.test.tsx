import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Feature } from '@betterdb/shared';

const { license, refreshFootprint, getStatus, getFootprintHistory, createEngine, connection, demo } = vi.hoisted(() => ({
  license: { licensed: true, loaded: true, failed: false },
  connection: { current: { id: 'c1' } as Record<string, unknown> },
  demo: { isDemo: false },
  refreshFootprint: vi.fn(),
  getStatus: vi.fn(),
  getFootprintHistory: vi.fn(),
  createEngine: vi.fn(),
}));

vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({
    license: license.loaded ? { tier: license.licensed ? 'pro' : 'community' } : null,
    hasFeature: (feature: string) => license.licensed && feature === Feature.KV_CACHE_MONITORING,
  }),
  useLicenseStatus: () => ({
    license: license.loaded ? { tier: license.licensed ? 'pro' : 'community' } : null,
    loading: !license.loaded && !license.failed,
    error: license.failed ? new Error('license request failed') : null,
  }),
}));
vi.mock('../../contexts/DemoContext', () => ({ useIsDemo: () => demo.isDemo }));
vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: connection.current }),
}));
vi.mock('../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { getStatus, getFootprintHistory, refreshFootprint, createEngine } };
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
  primariesScanned: 1,
  primariesTotal: 1,
  chunksEst: 0,
  bytesEst: 0,
  usedMemory: 0,
  maxmemory: 0,
  maxmemoryPolicy: 'noeviction',
  lmcacheMemoryShare: 0,
  noTtlRatio: 0,
  orphanRatio: null,
  evictedKeysDelta: null,
  evictedKeysIntervalMs: null,
  otherDbs: [3, 5],
  perModel: [],
};

describe('KvCacheGuard', () => {
  beforeEach(() => {
    license.licensed = true;
    license.loaded = true;
    license.failed = false;
    connection.current = { id: 'c1' };
    demo.isDemo = false;
    getStatus.mockReset();
    getFootprintHistory.mockReset();
    getFootprintHistory.mockResolvedValue([]);
    refreshFootprint.mockReset();
    refreshFootprint.mockResolvedValue(null);
    createEngine.mockReset();
  });

  it('shows a skeleton, not the upgrade prompt, while the license is loading', () => {
    license.licensed = false;
    license.loaded = false;
    const { container } = renderGuard();
    expect(screen.queryByText(/Upgrade to Pro/i)).toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByTestId('children')).toBeNull();
  });

  it('treats a failed license request as unlicensed instead of loading forever', () => {
    license.licensed = false;
    license.loaded = false;
    license.failed = true;
    const { container } = renderGuard();
    expect(screen.getByText(/Upgrade to Pro/i)).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('shows the upgrade prompt and no children when unlicensed', () => {
    license.licensed = false;
    renderGuard();
    expect(screen.getByText(/Upgrade to Pro/i)).toBeInTheDocument();
    expect(screen.queryByTestId('children')).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a cluster member', { id: 'k', host: 'h', membership: { seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster' } }],
    ['an agent connection', { id: 'a', host: 'agent', connectionType: 'agent' }],
  ])('explains that %s has no footprint instead of loading status', (_case, current) => {
    connection.current = current;
    renderGuard();
    expect(screen.getByText(/not collected for this connection/i)).toBeInTheDocument();
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
    expect(
      screen.getByText('[<key_prefix>@]<model>@<kv_rank:08x>@<group_hex>@<chunk_hash_hex>[@<cache_salt>]'),
    ).toBeInTheDocument();
    expect(screen.getByText(/lib-name=GlidePySync\(lmcache\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('children')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan now' }));
    await waitFor(() => expect(refreshFootprint).toHaveBeenCalledTimes(1));
  });

  it('says the first scan is still running instead of reporting LMCache as missing', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest: null, sampleKey: null, engines: [] });
    renderGuard();
    expect(await screen.findByText('Scanning for LMCache keys')).toBeInTheDocument();
    expect(screen.queryByText('No LMCache KV cache detected')).toBeNull();
    expect(screen.queryByTestId('children')).toBeNull();
  });

  it('opens the link-engine dialog while the first scan is running', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest: null, sampleKey: null, engines: [] });
    renderGuard();
    fireEvent.click(await screen.findByRole('button', { name: 'Link an engine' }));
    expect(await screen.findByText('Link LMCache engine')).toBeInTheDocument();
    expect(screen.getByText('Scanning for LMCache keys')).toBeInTheDocument();
  });

  it('hides Link during the first scan on the demo instance', async () => {
    demo.isDemo = true;
    getStatus.mockResolvedValue({ hasLmcache: false, latest: null, sampleKey: null, engines: [] });
    renderGuard();
    expect(await screen.findByText('Scanning for LMCache keys')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link an engine' })).toBeNull();
  });

  it('polls every five seconds until the first scan finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getStatus
        .mockResolvedValueOnce({ hasLmcache: false, latest: null, sampleKey: null, engines: [] })
        .mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
      renderGuard();
      expect(await screen.findByText('Scanning for LMCache keys')).toBeInTheDocument();
      expect(getStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getStatus).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('No LMCache KV cache detected')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the page and its history available when detection drops after earlier detections', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    getFootprintHistory.mockResolvedValue([{ ...latest, detected: true, timestamp: 0 }, latest]);
    renderGuard();
    expect(await screen.findByTestId('children')).toBeInTheDocument();
    expect(screen.getByText('No LMCache KV cache detected')).toBeInTheDocument();
  });

  it('does not ask for past history while LMCache is detected', async () => {
    getStatus.mockResolvedValue({ hasLmcache: true, latest: { ...latest, detected: true }, sampleKey: null, engines: [] });
    renderGuard();
    expect(await screen.findByTestId('children')).toBeInTheDocument();
    expect(getFootprintHistory).not.toHaveBeenCalled();
  });

  it('hides Rescan and Link on the demo instance', async () => {
    demo.isDemo = true;
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    renderGuard();
    expect(await screen.findByText(/Other databases with keys/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rescan now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link an engine' })).toBeNull();
  });

  it('shows the server message when a rescan fails', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    refreshFootprint.mockRejectedValue(new Error('A footprint refresh is already running'));
    renderGuard();
    fireEvent.click(await screen.findByRole('button', { name: 'Rescan now' }));
    expect(
      await screen.findByText('Could not rescan: A footprint refresh is already running'),
    ).toBeInTheDocument();
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

  it('renders children when engines are linked but no keys are detected', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [{ id: 'e1' }] });
    renderGuard();
    expect(await screen.findByTestId('children')).toBeInTheDocument();
  });

  it('opens the link-engine dialog from the not-detected state', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    renderGuard();
    fireEvent.click(await screen.findByRole('button', { name: 'Link an engine' }));
    expect(await screen.findByText('Link LMCache engine')).toBeInTheDocument();
    expect(screen.getByLabelText('Metrics URL')).toBeInTheDocument();
  });

  it('keeps the collector snippet open after linking the first engine', async () => {
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [] });
    renderGuard();
    fireEvent.click(await screen.findByRole('button', { name: 'Link an engine' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'OTLP' }));
    const engine = { id: 'e1', name: 'otlp-1', source: 'otlp', otlpEngineId: 'lmc-abc' };
    createEngine.mockResolvedValue(engine);
    getStatus.mockResolvedValue({ hasLmcache: false, latest, sampleKey: null, engines: [engine] });
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'otlp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByTestId('children')).toBeInTheDocument();
    expect(screen.getByTestId('collector-snippet')).toHaveTextContent('lmc-abc');
  });
});
