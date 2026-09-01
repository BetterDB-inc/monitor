import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Security from './Security';
import {
  HEALTHY_DATASET,
  advisory,
  finding,
  node,
  scanResult,
  unversionedAdvisory,
} from './__fixtures__/cve';

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

  it('names the upgrade that clears the most findings, not the one that clears fewest', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '8.0.9', [
            finding('CVE-A', { fixedIn: '8.0.11' }),
            finding('CVE-B', { fixedIn: '8.0.11' }),
            finding('CVE-C', { fixedIn: '8.0.12' }),
          ]),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const banner = await screen.findByTestId('upgrade-banner');

    expect(banner).toHaveTextContent('Upgrading to 8.0.11 clears 2 of them.');
    expect(banner).not.toHaveTextContent('8.0.12');
  });

  it('reports the severity counts the API returned, not the number of rows', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '8.0.9', [finding('CVE-A'), finding('CVE-B'), finding('CVE-C')], [], {
            severityCounts: { low: 0, medium: 1, high: 1, critical: 0 },
          }),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toHaveTextContent('2');
    expect(screen.getAllByTestId(/finding-row-/)).toHaveLength(3);
  });

  it('states the exploit probability rather than a dash when EPSS is known', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('finding-row-CVE-2026-63639')).toHaveTextContent('52.8 pct');
  });

  it('names the module a finding came from so it cannot be read as an engine CVE', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '8.0.9', [
            finding('CVE-MOD', { matchedOn: 'module', moduleName: 'search' }),
            finding('CVE-ENG'),
          ]),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('finding-scope-CVE-MOD')).toHaveTextContent('module search');
    expect(screen.getByTestId('finding-scope-CVE-ENG')).toHaveTextContent('engine');
  });

  it('links each advisory out to its published reference', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '8.0.9', [
            finding('CVE-2026-63639', {
              advisory: advisory('CVE-2026-63639', {
                references: ['javascript:alert(1)', 'https://github.com/advisories/GHSA-x'],
              }),
            }),
          ]),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const link = await screen.findByRole('link', { name: 'CVE-2026-63639' });

    expect(link).toHaveAttribute('href', 'https://github.com/advisories/GHSA-x');
  });

  it('shows one row when a CVE is reported both matched and unversioned', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [node('1', '8.0.9', [finding('CVE-DUP')], [unversionedAdvisory('CVE-DUP')])],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findAllByTestId('finding-row-CVE-DUP')).toHaveLength(1);
    expect(screen.getByTestId('filter-chip-all')).toHaveTextContent('All 1');
  });

  it('says the table is empty instead of rendering a bare header row', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('findings-empty')).toBeInTheDocument();
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

  it('refuses to read as an all-clear when the scan skipped a source', async () => {
    mocks.scan.mockResolvedValue(scanResult({ partial: true, missingSources: ['nvd'] }));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const banner = await screen.findByTestId('source-banner');

    expect(banner).toHaveTextContent(/incomplete/i);
    expect(banner).toHaveTextContent('NVD');
  });

  it('states how old the stored scan is, separately from the advisory dataset age', async () => {
    const hour = 3_600_000;
    mocks.scan.mockResolvedValue(
      scanResult({ scannedAt: Date.now() - 3 * hour, lastCheckedAt: Date.now() - 3 * hour }),
    );
    mocks.dataset.mockResolvedValue({ ...HEALTHY_DATASET, refreshedAt: Date.now() - hour });

    renderPage();

    const subtitle = await screen.findByTestId('header-subtitle');

    expect(subtitle).toHaveTextContent('scanned 3h ago');
    expect(subtitle).toHaveTextContent('advisories refreshed 1h ago');
  });

  it('distinguishes when a stored scan was produced from when it was last confirmed', async () => {
    const hour = 3_600_000;
    mocks.scan.mockResolvedValue(
      scanResult({ scannedAt: Date.now() - 9 * hour, lastCheckedAt: Date.now() - 2 * hour }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('header-subtitle')).toHaveTextContent(
      'scanned 9h ago, rechecked 2h ago',
    );
  });

  it('says a rescan failed instead of quietly re-enabling the button over stale data', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);
    mocks.refresh.mockRejectedValue(new Error('connection refused'));

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Rescan' }));

    expect(await screen.findByTestId('rescan-error')).toHaveTextContent('connection refused');
    expect(screen.getByTestId('verdict-count')).toHaveTextContent('1');
  });

  it('shows the rescanned result when the rescan succeeds', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);
    mocks.refresh.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [finding('CVE-A'), finding('CVE-B')])] }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Rescan' }));

    await waitFor(() => {
      expect(screen.getByTestId('verdict-count')).toHaveTextContent('2');
    });
    expect(screen.queryByTestId('rescan-error')).not.toBeInTheDocument();
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

    const list = await screen.findByTestId('not-scanned-list');

    expect(within(list).getByText('10.0.0.4:6379')).toBeInTheDocument();
    expect(within(list).getByText(/unreachable/i)).toBeInTheDocument();
  });
});
