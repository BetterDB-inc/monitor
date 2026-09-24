import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CveAlertBanner } from './CveAlertBanner';
import { finding, node, scanResult } from '@/pages/__fixtures__/cve';

describe('CveAlertBanner', () => {
  it('renders nothing when there are no critical or KEV findings', () => {
    const { container } = render(<CveAlertBanner result={scanResult()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a destructive banner for critical findings', () => {
    const result = scanResult({
      nodes: [
        node('1', '8.0.9', [
          finding('CVE-2026-00001', {
            advisory: { ...finding('CVE-2026-00001').advisory, severity: 'critical' },
          }),
        ]),
      ],
    });
    // Fix severityCounts for the banner count path
    result.nodes[0].severityCounts = { critical: 1, high: 0, medium: 0, low: 0 };

    render(<CveAlertBanner result={result} />);

    expect(screen.getByTestId('cve-alert-banner')).toBeInTheDocument();
    expect(screen.getByText('Critical CVEs detected')).toBeInTheDocument();
    expect(screen.getByTestId('cve-alert-CVE-2026-00001')).toBeInTheDocument();
  });

  it('renders a KEV banner when only exploited findings exist', () => {
    const base = finding('CVE-2026-00002');
    const result = scanResult({
      nodes: [
        node('1', '8.0.9', [
          {
            ...base,
            advisory: { ...base.advisory, severity: 'high', knownExploited: true },
          },
        ]),
      ],
    });

    render(<CveAlertBanner result={result} />);

    expect(screen.getByTestId('cve-alert-banner')).toBeInTheDocument();
    expect(screen.getByText('Exploited (KEV) CVEs detected')).toBeInTheDocument();
    expect(screen.getByTestId('cve-alert-kev')).toBeInTheDocument();
  });

  it('de-duplicates a shared CVE across cluster nodes into one badge', () => {
    const critical = (cveId: string) =>
      finding(cveId, {
        advisory: { ...finding(cveId).advisory, severity: 'critical' },
      });
    const result = scanResult({
      nodes: [node('1', '8.0.9', [critical('CVE-2026-00001')]), node('2', '8.0.9', [critical('CVE-2026-00001')])],
    });

    render(<CveAlertBanner result={result} />);

    expect(screen.getByTestId('cve-alert-banner')).toBeInTheDocument();
    expect(screen.getAllByTestId('cve-alert-CVE-2026-00001')).toHaveLength(1);
  });
});
