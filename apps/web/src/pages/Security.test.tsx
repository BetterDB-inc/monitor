import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <Security />
    </QueryClientProvider>,
  );
}

describe('Security page', () => {
  it('names the version the findings were matched against', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(
      await screen.findByText(/Matched against the reported engine version 8\.0\.9/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Valkey 8\.0\.9/)).toBeInTheDocument();
  });

  it('counts only the versioned findings in the verdict', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toHaveTextContent('1');
  });

  it('lists the unversioned advisory as an UNKNOWN row rather than hiding it', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByText('CVE-2025-49112')).toBeInTheDocument();
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('states the larger number on the filter chip, so counts and rows disagree by design', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('filter-chip-all')).toHaveTextContent('2');
    expect(screen.getByTestId('verdict-count')).toHaveTextContent('1');
  });

  it('names the upgrade that clears the most findings', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('upgrade-banner')).toHaveTextContent('8.0.10');
  });

  it('keeps the ranking the API returned, flagging the known-exploited finding', async () => {
    const exploited = finding('CVE-2025-49844', {
      advisory: {
        ...finding('CVE-2025-49844').advisory,
        severity: 'critical',
        cvssScore: 7.0,
        knownExploited: true,
        epssScore: 0.868,
        epssPercentile: 0.997,
      },
    });
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.9', [exploited, finding('CVE-2026-63639')])] }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const rows = await screen.findAllByTestId(/finding-row-/);

    expect(rows[0]).toHaveTextContent('CVE-2025-49844');
    expect(rows[0]).toHaveTextContent('KEV');
    expect(rows[1]).toHaveTextContent('CVE-2026-63639');
    expect(rows[1]).not.toHaveTextContent('KEV');
  });

  it('says so plainly when nothing matched', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toHaveTextContent('0');
    expect(screen.queryByTestId('upgrade-banner')).not.toBeInTheDocument();
  });

  it('lists unreachable nodes with their reason', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        notScanned: [{ nodeId: 'node-4', address: '10.0.0.4:6379', reason: 'unreachable' }],
        partial: true,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByText('10.0.0.4:6379')).toBeInTheDocument();
    expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
  });
});
