import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { status } = vi.hoisted(() => ({
  status: { data: undefined as unknown },
}));

vi.mock('../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
}));
vi.mock('../../hooks/useKvCacheStatus', () => ({
  useKvCacheStatus: () => status,
}));
vi.mock('../../hooks/useRescanKvCache', () => ({
  useRescanKvCache: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useCanMutate', () => ({
  useCanMutate: () => false,
}));
vi.mock('../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/kv-cache')>();
  return {
    ...actual,
    kvCacheApi: {
      getFootprintHistory: vi.fn().mockResolvedValue([]),
      getSamples: vi.fn().mockResolvedValue({ buckets: [], rangeHitRate: null }),
    },
  };
});
vi.mock('../../components/pages/kv-cache', () => ({
  KvCacheAdvisories: () => <div data-testid="advisories" />,
  KvCacheCards: () => <div data-testid="cards" />,
  KvCacheCharts: () => <div data-testid="charts" />,
  KvCacheEngines: () => <div data-testid="engines" />,
  KvCacheModelTable: () => <div data-testid="model-table" />,
  KvCacheSettingsSheet: () => null,
  advisoriesFor: () => [],
}));

import { KvCache } from '../KvCache';

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
});
