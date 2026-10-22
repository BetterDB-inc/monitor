import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { status, getFootprintHistory, access, rescanState, getSamples, cardsProps } = vi.hoisted(() => ({
  status: { data: undefined as unknown },
  access: { canMutate: false, isDemo: false },
  rescanState: { error: null as Error | null },
  getSamples: vi.fn(),
  cardsProps: { history: undefined as unknown },
  getFootprintHistory: vi.fn(),
}));

vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
}));
vi.mock('../../hooks/useKvCacheStatus', () => ({
  useKvCacheStatus: () => status,
}));
vi.mock('../../hooks/useRescanKvCache', () => ({
  useRescanKvCache: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: rescanState.error !== null,
    error: rescanState.error,
  }),
}));
vi.mock('../../hooks/useCanMutate', () => ({
  useCanMutate: () => access.canMutate,
}));
vi.mock('../../contexts/DemoContext', () => ({
  useIsDemo: () => access.isDemo,
}));
vi.mock('../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/kv-cache')>();
  return {
    ...actual,
    kvCacheApi: {
      getFootprintHistory,
      getSamples,
    },
  };
});
vi.mock('../../components/pages/kv-cache', async () => ({
  samplesStartedAfter: (
    await vi.importActual<typeof import('../../components/pages/kv-cache/kv-cache-format')>(
      '../../components/pages/kv-cache/kv-cache-format',
    )
  ).samplesStartedAfter,
  KvCacheAdvisories: () => <div data-testid="advisories" />,
  KvCacheCards: (props: { history: unknown }) => {
    cardsProps.history = props.history;
    return <div data-testid="cards" />;
  },
  KvCacheCharts: () => <div data-testid="charts" />,
  KvCacheEngines: () => <div data-testid="engines" />,
  KvCacheModelTable: () => <div data-testid="model-table" />,
  KvCacheSettingsSheet: () => <div data-testid="settings-sheet" />,
  advisoriesFor: () => [],
}));

import { KvCache, chartRefetchInterval, isReversedRange } from '../KvCache';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KvCache />
    </QueryClientProvider>,
  );
}

describe('KvCache page', () => {
  beforeEach(() => {
    status.data = undefined;
    access.canMutate = false;
    access.isDemo = false;
    rescanState.error = null;
    getFootprintHistory.mockReset().mockResolvedValue([]);
    getSamples.mockReset().mockResolvedValue({ buckets: [], rangeHitRate: null });
    cardsProps.history = undefined;
  });

  it('renders engine-sample panels when engines are linked without a snapshot', () => {
    status.data = { latest: null, engines: [{ id: 'e1', name: 'vllm' }] };
    renderPage();
    expect(screen.getByTestId('cards')).toBeInTheDocument();
    expect(screen.getByTestId('charts')).toBeInTheDocument();
    expect(screen.queryByTestId('advisories')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-table')).not.toBeInTheDocument();
  });

  it('renders every panel when a snapshot exists', () => {
    status.data = { latest: { perModel: [] }, engines: [] };
    renderPage();
    expect(screen.getByTestId('cards')).toBeInTheDocument();
    expect(screen.getByTestId('charts')).toBeInTheDocument();
    expect(screen.getByTestId('advisories')).toBeInTheDocument();
    expect(screen.getByTestId('model-table')).toBeInTheDocument();
  });

  it('renders only the engines panel with neither snapshot nor engines', () => {
    status.data = { latest: null, engines: [] };
    renderPage();
    expect(screen.queryByTestId('cards')).not.toBeInTheDocument();
    expect(screen.queryByTestId('charts')).not.toBeInTheDocument();
    expect(screen.getByTestId('engines')).toBeInTheDocument();
  });

  it('shows Refresh and settings to admins', () => {
    access.canMutate = true;
    status.data = { latest: null, engines: [] };
    renderPage();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByTestId('settings-sheet')).toBeInTheDocument();
  });

  it('shows the server message when Refresh fails', () => {
    access.canMutate = true;
    rescanState.error = new Error('A footprint refresh is already running');
    status.data = { latest: null, engines: [] };
    renderPage();
    expect(
      screen.getByText('Could not refresh: A footprint refresh is already running'),
    ).toBeInTheDocument();
  });

  it('hides Refresh and settings on the demo instance', () => {
    access.canMutate = true;
    access.isDemo = true;
    status.data = { latest: null, engines: [] };
    renderPage();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(screen.queryByTestId('settings-sheet')).toBeNull();
  });

  it('feeds the cards the latest two snapshots from status', () => {
    const recent = [{ timestamp: 1 }, { timestamp: 2 }];
    status.data = { latest: { perModel: [] }, recent, engines: [] };
    renderPage();
    expect(cardsProps.history).toBe(recent);
  });

  it('does not poll engine samples with no engines linked', async () => {
    status.data = { latest: { perModel: [] }, engines: [] };
    renderPage();
    await waitFor(() => expect(getFootprintHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(getSamples).not.toHaveBeenCalled();
  });

  it('fetches engine samples once engines are linked', async () => {
    status.data = { latest: null, engines: [{ id: 'e1', name: 'vllm' }] };
    renderPage();
    await waitFor(() => expect(getSamples).toHaveBeenCalled());
  });

  it('notes when engine samples start after the requested range', async () => {
    const first = Date.now() - 60 * 60 * 1000;
    getSamples.mockResolvedValue({
      buckets: [{ timestamp: first, modelName: 'm', hitTokens: 1, requestedTokens: 2 }],
      rangeHitRate: 0.5,
    });
    status.data = { latest: null, engines: [{ id: 'e1', name: 'vllm' }] };
    renderPage();
    expect(await screen.findByText(/^Showing engine data since /)).toBeInTheDocument();
  });

  it('shows a failed footprint history request instead of an empty range', async () => {
    getFootprintHistory.mockRejectedValue(new Error('Server unavailable'));
    status.data = { latest: { perModel: [] }, engines: [] };
    renderPage();
    expect(await screen.findByText('Could not load KV cache data: Server unavailable')).toBeInTheDocument();
  });

  it('shows a failed engine samples request instead of an empty range', async () => {
    getSamples.mockRejectedValue(new Error('from must be before to'));
    status.data = { latest: null, engines: [{ id: 'e1', name: 'vllm' }] };
    renderPage();
    expect(await screen.findByText('Could not load KV cache data: from must be before to')).toBeInTheDocument();
  });

  it('drops a failed engine samples error once the last engine is unlinked', async () => {
    getSamples.mockRejectedValue(new Error('from must be before to'));
    status.data = { latest: { perModel: [] }, engines: [{ id: 'e1', name: 'vllm' }] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = () => (
      <QueryClientProvider client={client}>
        <KvCache />
      </QueryClientProvider>
    );
    const { rerender } = render(page());
    expect(await screen.findByText('Could not load KV cache data: from must be before to')).toBeInTheDocument();
    status.data = { latest: { perModel: [] }, engines: [] };
    rerender(page());
    await waitFor(() => expect(screen.queryByText(/^Could not load KV cache data/)).toBeNull());
  });

  it('fetches the default footprint history once', async () => {
    status.data = { latest: { perModel: [] }, engines: [] };
    renderPage();
    await waitFor(() => expect(getFootprintHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(getFootprintHistory).toHaveBeenCalledTimes(1);
  });
});

describe('chartRefetchInterval', () => {
  const now = 1_000_000;

  it('polls with no range picked', () => {
    expect(chartRefetchInterval(undefined, now)).toBe(60_000);
  });

  it('keeps polling while the picked range ends in the future', () => {
    expect(chartRefetchInterval({ from: new Date(now - 1000), to: new Date(now + 1000) }, now)).toBe(
      60_000,
    );
  });

  it('polls at the given interval', () => {
    expect(chartRefetchInterval(undefined, now, 300_000)).toBe(300_000);
  });

  it('stops polling once the picked range has ended', () => {
    expect(chartRefetchInterval({ from: new Date(now - 2000), to: new Date(now - 1000) }, now)).toBe(
      false,
    );
  });
});

describe('isReversedRange', () => {
  it('flags a picked range whose end is before its start', () => {
    expect(isReversedRange({ from: new Date(2000), to: new Date(1000) })).toBe(true);
    expect(isReversedRange({ from: new Date(1000), to: new Date(2000) })).toBe(false);
    expect(isReversedRange(undefined)).toBe(false);
  });
});
