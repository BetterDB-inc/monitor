import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Security from './Security';
import {
  HEALTHY_DATASET,
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
      <MemoryRouter>
        <Security />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('Security page - incomplete scans must never read as an all-clear', () => {
  it('refuses the all-clear headline when the server marked the scan partial', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true, missingSources: [] }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).not.toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent(/this scan is incomplete/i);
    expect(screen.getByTestId('scan-caveat-partial')).toBeInTheDocument();
  });

  it('names the module whose version could not be read as the reason a scan is partial', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '8.0.10', [], [], {
            modules: [
              { name: 'search', version: null },
              { name: 'json', version: '1.0.0' },
            ],
          }),
        ],
        partial: true,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const caveat = await screen.findByTestId('scan-caveat-undecoded-modules');

    expect(caveat).toHaveTextContent('search');
    expect(caveat).not.toHaveTextContent('json');
  });

  it('keeps the all-clear when the only unreadable modules carry no advisories of their own', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node('1', '9.0.0', [], [], {
            modules: [
              { name: 'lua', version: null },
              { name: 'vectorset', version: null },
            ],
          }),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.queryByTestId('scan-caveat-undecoded-modules')).not.toBeInTheDocument();
  });

  it('refuses the all-clear headline when the modules on a node could not be enumerated', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [node('1', '8.0.10', [], [], { modules: [], modulesUnknown: true })],
        partial: false,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).not.toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent(/this scan is incomplete/i);

    const caveat = screen.getByTestId('scan-caveat-modules-unknown');

    expect(caveat).toHaveTextContent('10.0.0.1:6379');
    expect(caveat).toHaveTextContent(/unknown, not absent/i);
  });

  it('keeps the all-clear when an empty module list was actually enumerated', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [], [], { modules: [] })] }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.queryByTestId('scan-caveat-modules-unknown')).not.toBeInTheDocument();
  });

  it('counts unversioned advisories in the verdict rather than headlining zero', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        nodes: [
          node(
            '1',
            '8.0.10',
            [],
            [unversionedAdvisory('CVE-2025-49112'), unversionedAdvisory('CVE-2025-49113')],
          ),
        ],
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-count')).toHaveTextContent('0');
    expect(screen.getByTestId('verdict-unchecked-count')).toHaveTextContent('2');
    expect(screen.getByTestId('verdict-headline')).not.toHaveTextContent(
      '0 known CVEs affect this instance',
    );
  });

  it('caveats the verdict for unreachable nodes inside the verdict card, not below the fold', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        nodes: [node('1', '8.0.10', [])],
        notScanned: [{ nodeId: '2', address: '10.0.0.2:6379', reason: 'auth failed' }],
        partial: true,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const caveats = await screen.findByTestId('scan-caveats');
    const caveat = screen.getByTestId('scan-caveat-not-scanned');

    expect(caveat).toHaveTextContent('10.0.0.2:6379');
    expect(caveat).toHaveTextContent('auth failed');
    expect(screen.getByTestId('verdict-headline')).not.toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.getByTestId('empty-scan')).toContainElement(caveats);
    expect(precedes(screen.getByTestId('verdict-headline'), caveats)).toBe(true);
    expect(precedes(caveats, screen.getByTestId('source-dot-ghsa'))).toBe(true);
  });

  it('names the skipped source in the verdict caveat, not only in the source strip', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true, missingSources: ['nvd'] }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('scan-caveat-missing-sources')).toHaveTextContent('NVD');
    expect(screen.getByTestId('verdict-headline')).not.toHaveTextContent(
      '0 known CVEs affect this instance',
    );
  });

  it('keeps the plain all-clear when the scan really is complete', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.queryByTestId('scan-caveats')).not.toBeInTheDocument();
  });

  it('points at the missing GitHub token when GHSA is the source that dropped out', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true, missingSources: ['ghsa'] }),
    );
    mocks.dataset.mockResolvedValue({ ...HEALTHY_DATASET, ghsaAuthenticated: false });

    renderPage();

    expect(await screen.findByTestId('ghsa-token-notice')).toHaveTextContent('CVE_GITHUB_TOKEN');
  });

  it('does not blame the token when GHSA dropped out with one configured', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true, missingSources: ['ghsa'] }),
    );
    mocks.dataset.mockResolvedValue({ ...HEALTHY_DATASET, ghsaAuthenticated: true });

    renderPage();

    await screen.findByTestId('scan-caveat-missing-sources');

    expect(screen.queryByTestId('ghsa-token-notice')).not.toBeInTheDocument();
  });

  it('does not blame the token when a source other than GHSA dropped out', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true, missingSources: ['nvd'] }),
    );
    mocks.dataset.mockResolvedValue({ ...HEALTHY_DATASET, ghsaAuthenticated: false });

    renderPage();

    await screen.findByTestId('scan-caveat-missing-sources');

    expect(screen.queryByTestId('ghsa-token-notice')).not.toBeInTheDocument();
  });

  it('names the engine product beside the version in the empty state', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('empty-scan')).toHaveTextContent('Valkey 8.0.10 was checked');
  });

  it('keeps every per-node reason when the whole cluster was unreachable', async () => {
    mocks.scan.mockResolvedValue(
      scanResult({
        topology: 'cluster',
        nodes: [],
        notScanned: [
          { nodeId: '1', address: '10.0.0.1:6379', reason: 'auth failed' },
          { nodeId: '2', address: '10.0.0.2:6379', reason: 'unreachable' },
        ],
        partial: true,
      }),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const list = await screen.findByTestId('not-scanned-list');

    expect(list).toHaveTextContent('10.0.0.1:6379');
    expect(list).toHaveTextContent('auth failed');
    expect(list).toHaveTextContent('10.0.0.2:6379');
    expect(list).toHaveTextContent('unreachable');
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeInTheDocument();
  });

  it('reads a failed scan as a blank rather than as zero findings', async () => {
    mocks.scan.mockRejectedValue(
      new Error(
        "No node in this connection could be scanned: localhost:6395: Stream isn't writeable",
      ),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'This connection could not be scanned',
    );
    expect(screen.getByTestId('severity-badge-critical')).not.toHaveTextContent('0');
    expect(screen.getByTestId('severity-badge-critical')).toHaveTextContent('critical');
    expect(screen.queryByTestId('verdict-count')).not.toBeInTheDocument();
  });

  it('names the node and keeps the raw client error as the reason', async () => {
    mocks.scan.mockRejectedValue(
      new Error(
        "No node in this connection could be scanned: localhost:6395: Stream isn't writeable",
      ),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    const reason = await screen.findByTestId('scan-failure-reason');

    expect(reason).toHaveTextContent('localhost:6395');
    expect(reason).toHaveTextContent("Stream isn't writeable");
    expect(reason).toHaveTextContent(/INFO and MODULE LIST/);
  });

  it('gives a cluster one reason per node instead of a blanket message', async () => {
    mocks.scan.mockRejectedValue(
      new Error(
        'No node in this connection could be scanned: 127.0.0.1:7401: Connection refused; 127.0.0.1:7402: NOAUTH Authentication required',
      ),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'No node in this cluster could be scanned',
    );

    const list = screen.getByTestId('not-scanned-list');

    expect(list).toHaveTextContent('127.0.0.1:7401');
    expect(list).toHaveTextContent('Connection refused');
    expect(list).toHaveTextContent('127.0.0.1:7402');
    expect(list).toHaveTextContent('NOAUTH Authentication required');
  });

  it('says the feeds are healthy so the failure is not read as stale data', async () => {
    mocks.scan.mockRejectedValue(
      new Error('No node in this connection could be scanned: db:6379: down'),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('failed-scan-sources')).toHaveTextContent(
      /failure is on this connection, not on the data/i,
    );
  });

  it('does not blame the connection for the feeds when a source is down', async () => {
    mocks.scan.mockRejectedValue(
      new Error('No node in this connection could be scanned: db:6379: down'),
    );
    mocks.dataset.mockResolvedValue({
      ...HEALTHY_DATASET,
      healthy: false,
      sources: HEALTHY_DATASET.sources.map((source) => {
        if (source.source !== 'nvd') {
          return source;
        }

        return { ...source, state: 'quiet' as const };
      }),
    });

    renderPage();

    await screen.findByTestId('failed-scan');

    expect(screen.queryByTestId('failed-scan-sources')).not.toBeInTheDocument();
  });

  it('tells the reader the connection is gone rather than showing a client error', async () => {
    mocks.scan.mockRejectedValue(
      new Error(
        "Connection 'conn-9' not found. Use GET /connections to list available connections.",
      ),
    );
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(
      'This connection no longer exists',
    );
    expect(screen.getByTestId('scan-error')).not.toHaveTextContent('GET /connections');
  });

  it('shows the server message and a retry when the scan request fails', async () => {
    mocks.scan.mockRejectedValue(new Error('CVE dataset is still being built'));
    mocks.dataset.mockResolvedValue(HEALTHY_DATASET);

    renderPage();

    expect(await screen.findByTestId('scan-error')).toHaveTextContent(
      'CVE dataset is still being built',
    );
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeInTheDocument();
    expect(screen.queryByTestId('verdict-count')).not.toBeInTheDocument();
  });

  it('refuses the all-clear when a source went quiet on the last corpus refresh', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue({
      ...HEALTHY_DATASET,
      healthy: false,
      sources: HEALTHY_DATASET.sources.map((source) => {
        if (source.source !== 'nvd') {
          return source;
        }

        return { ...source, state: 'quiet' as const, recordCount: 0 };
      }),
    });

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).not.toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent(/this scan is incomplete/i);
    expect(screen.getByTestId('scan-caveat-dataset-degraded')).toHaveTextContent('NVD');
  });

  it('refuses the all-clear when the corpus holds no advisories at all', async () => {
    mocks.scan.mockResolvedValue(scanResult({ nodes: [node('1', '8.0.10', [])] }));
    mocks.dataset.mockResolvedValue({ ...HEALTHY_DATASET, advisoryCount: 0, healthy: false });

    renderPage();

    expect(await screen.findByTestId('verdict-headline')).not.toHaveTextContent(
      'No known vulnerabilities found',
    );
    expect(screen.getByTestId('scan-caveat-dataset-empty')).toBeInTheDocument();
  });

  it('does not claim the advisory dataset is empty when its request failed', async () => {
    mocks.scan.mockResolvedValue(scanResult());
    mocks.dataset.mockRejectedValue(new Error('dataset unavailable'));

    renderPage();

    await screen.findByTestId('verdict-headline');

    const banner = await screen.findByTestId('source-banner');

    expect(banner).not.toHaveTextContent(/no advisory data/i);
    expect(banner).toHaveTextContent(/source health could not be loaded/i);
  });
});
