import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Security from './Security';
import { HEALTHY_DATASET, finding, node, scanResult } from './__fixtures__/cve';

const mocks = vi.hoisted(() => {
  return { scan: vi.fn(), dataset: vi.fn(), refresh: vi.fn() };
});

vi.mock('../api/cve', () => {
  return {
    fetchCveScan: mocks.scan,
    fetchCveDataset: mocks.dataset,
    refreshCveScan: mocks.refresh,
  };
});

vi.mock('../hooks/useConnection', () => {
  return {
    useConnection: () => {
      return {
        currentConnection: {
          id: 'conn-1',
          name: 'local',
          host: '127.0.0.1',
          port: 6379,
          isConnected: true,
        },
        connections: [],
        loading: false,
        error: null,
        setConnection: vi.fn(),
        refreshConnections: vi.fn(),
        hasNoConnections: false,
      };
    },
  };
});

function driftResult() {
  return scanResult({
    topology: 'cluster',
    drift: true,
    nodes: [
      node('1', '8.0.9', [finding('CVE-A')]),
      node('2', '8.0.4', [finding('CVE-A'), finding('CVE-B')]),
    ],
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Security />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Security page - drift state', () => {
  it('shows the node list when the cluster reports more than one version', async () => {
    mocks.scan.mockResolvedValue(driftResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('node-list')).toBeInTheDocument();
    expect(screen.getByTestId('node-row-1')).toHaveTextContent('8.0.9');
    expect(screen.getByTestId('node-row-2')).toHaveTextContent('8.0.4');
  });

  it('calls out the drift itself, not only the CVEs', async () => {
    mocks.scan.mockResolvedValue(driftResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const banner = await screen.findByTestId('drift-banner');

    expect(banner).toHaveTextContent(/two versions/i);
    expect(banner).toHaveTextContent('8.0.4');
    expect(banner).toHaveTextContent('8.0.9');
  });

  it('gives each node a badge equal to unique plus shared', async () => {
    mocks.scan.mockResolvedValue(driftResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('node-badge-2')).toHaveTextContent('2');
    expect(screen.getByTestId('node-badge-1')).toHaveTextContent('1');
  });

  it('separates unique from shared findings for the selected node', async () => {
    mocks.scan.mockResolvedValue(driftResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    fireEvent.click(await screen.findByTestId('node-row-2'));

    expect(screen.getByTestId('group-unique')).toHaveTextContent('CVE-B');
    expect(screen.getByTestId('group-shared')).toHaveTextContent('CVE-A');
    expect(screen.getByTestId('group-unique')).not.toHaveTextContent('CVE-A');
  });

  it('stays in the default state when every node reports the same version', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        nodes: [node('1', '8.0.9', [finding('CVE-A')]), node('2', '8.0.9', [finding('CVE-A')])],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toBeInTheDocument();
    expect(screen.queryByTestId('node-list')).not.toBeInTheDocument();
  });

  it('trusts the drift flag the API returned over counting versions itself', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'standalone',
        drift: false,
        nodes: [node('1', '8.0.9', [finding('CVE-A')]), node('2', '8.0.4', [finding('CVE-A')])],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toBeInTheDocument();
    expect(screen.queryByTestId('node-list')).not.toBeInTheDocument();
  });

  it('enters the drift state on the API flag even when one version is reported', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        drift: true,
        nodes: [node('1', '8.0.9', [finding('CVE-A')]), node('2', '8.0.9', [finding('CVE-A')])],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('node-list')).toBeInTheDocument();
    expect(screen.queryByTestId('verdict-count')).not.toBeInTheDocument();
  });

  it('marks the selected node as pressed, not by background colour alone', async () => {
    mocks.scan.mockResolvedValue(driftResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    fireEvent.click(await screen.findByTestId('node-row-2'));

    expect(screen.getByTestId('node-row-2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('node-row-1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not enter the drift state because a node was unreachable', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        nodes: [node('1', '8.0.9', [finding('CVE-A')])],
        notScanned: [{ nodeId: '2', address: '10.0.0.2:6379', reason: 'unreachable' }],
        partial: true,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toBeInTheDocument();
    expect(screen.queryByTestId('node-list')).not.toBeInTheDocument();
    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument();
  });
});
