import { render, screen } from '@testing-library/react';
import type { CveSourceStatus } from '@betterdb/shared';
import { describe, expect, it } from 'vitest';
import { SourceStrip } from './SourceStrip';

function status(
  overrides: Partial<CveSourceStatus> & Pick<CveSourceStatus, 'source'>,
): CveSourceStatus {
  return {
    state: 'ok',
    lastSuccessAt: 1,
    lastAttemptAt: 1,
    recordCount: 14,
    previousRecordCount: 14,
    query: `${overrides.source}-query`,
    ...overrides,
  };
}

const HEALTHY: CveSourceStatus[] = [
  status({ source: 'ghsa' }),
  status({ source: 'nvd', query: 'cpe:2.3:a:lfprojects:valkey' }),
  status({ source: 'mitre' }),
  status({ source: 'kev' }),
  status({ source: 'epss' }),
];

describe('SourceStrip', () => {
  it('shows every source healthy and no banner', () => {
    render(<SourceStrip sources={HEALTHY} />);

    expect(screen.getAllByTestId(/source-dot-/)).toHaveLength(5);
    expect(screen.queryByTestId('source-banner')).not.toBeInTheDocument();
  });

  it('warns that findings may be incomplete when a source has gone quiet', () => {
    const sources = [...HEALTHY];
    sources[0] = status({ source: 'ghsa', state: 'quiet', message: 'timeout' });

    render(<SourceStrip sources={sources} />);

    expect(screen.getByTestId('source-banner')).toHaveTextContent(/may be incomplete/i);
    expect(screen.getByTestId('source-dot-ghsa')).toHaveAttribute('data-state', 'quiet');
  });

  it('names the query and the previous count when a source answers with nothing', () => {
    const sources = [...HEALTHY];
    sources[1] = status({
      source: 'nvd',
      state: 'empty',
      recordCount: 0,
      previousRecordCount: 14,
      query: 'cpe:2.3:a:lfprojects:valkey',
    });

    render(<SourceStrip sources={sources} />);

    const banner = screen.getByTestId('source-banner');

    expect(banner).toHaveTextContent('cpe:2.3:a:lfprojects:valkey');
    expect(banner).toHaveTextContent('0 results');
    expect(banner).toHaveTextContent('14');
  });

  it('prefers the empty banner over the quiet one when both are present', () => {
    const sources = [...HEALTHY];
    sources[0] = status({ source: 'ghsa', state: 'quiet' });
    sources[1] = status({ source: 'nvd', state: 'empty', recordCount: 0, previousRecordCount: 14 });

    render(<SourceStrip sources={sources} />);

    expect(screen.getByTestId('source-banner')).toHaveTextContent('0 results');
  });

  it('says the dataset has never been built rather than showing green dots', () => {
    render(<SourceStrip sources={[]} />);

    expect(screen.queryByTestId(/source-dot-/)).not.toBeInTheDocument();
    expect(screen.getByTestId('source-banner')).toHaveTextContent(/no advisory data/i);
  });

  it('says the scan skipped a source rather than letting the dots read as an all-clear', () => {
    render(<SourceStrip sources={HEALTHY} missingSources={['nvd']} />);

    const banner = screen.getByTestId('source-banner');

    expect(banner).toHaveTextContent(/incomplete/i);
    expect(banner).toHaveTextContent('NVD');
  });

  it('prefers the missing-source banner over the quiet one', () => {
    const sources = [...HEALTHY];
    sources[0] = status({ source: 'ghsa', state: 'quiet' });

    render(<SourceStrip sources={sources} missingSources={['nvd']} />);

    const banner = screen.getByTestId('source-banner');

    expect(banner).toHaveTextContent('NVD');
    expect(banner).not.toHaveTextContent(/could not be reached/i);
  });

  it('prefers the empty banner over the missing-source one', () => {
    const sources = [...HEALTHY];
    sources[1] = status({ source: 'nvd', state: 'empty', recordCount: 0, previousRecordCount: 14 });

    render(<SourceStrip sources={sources} missingSources={['mitre']} />);

    expect(screen.getByTestId('source-banner')).toHaveTextContent('0 results');
  });

  it('points at the findings on this page, never at findings below it', () => {
    render(<SourceStrip sources={HEALTHY} missingSources={['nvd']} />);

    expect(screen.getByTestId('source-banner')).not.toHaveTextContent(/findings below/i);
  });

  it('keeps the warning banner on the page foreground colour so it stays legible', () => {
    render(<SourceStrip sources={HEALTHY} missingSources={['nvd']} />);

    const banner = screen.getByTestId('source-banner');

    expect(banner.className).toContain('border-chart-warning');
    expect(banner.className).toContain('text-foreground');
    expect(banner.className).not.toContain('text-chart-warning');
  });

  it('marks a healthy source green in both themes', () => {
    render(<SourceStrip sources={HEALTHY} />);

    const dot = screen.getByTestId('source-dot-ghsa');

    expect(dot.className).toContain('bg-success');
    expect(dot.className).toContain('dark:bg-success-foreground');
    expect(dot.className).not.toContain('bg-destructive');
  });

  it('marks a source that answered with nothing as destructive, not healthy', () => {
    const sources = [...HEALTHY];
    sources[1] = status({ source: 'nvd', state: 'empty', recordCount: 0, previousRecordCount: 14 });

    render(<SourceStrip sources={sources} />);

    expect(screen.getByTestId('source-dot-nvd').className).toContain('bg-destructive');
    expect(screen.getByTestId('source-dot-ghsa').className).not.toContain('bg-destructive');
  });

  it('names each source state for a reader who cannot see the colour', () => {
    const sources = [...HEALTHY];
    sources[0] = status({ source: 'ghsa', state: 'quiet' });

    render(<SourceStrip sources={sources} />);

    expect(screen.getByLabelText('GHSA unreachable')).toBeInTheDocument();
    expect(screen.getByLabelText('NVD healthy')).toBeInTheDocument();
  });

  it('claims nothing about the dataset while it is still loading', () => {
    render(<SourceStrip sources={[]} loading />);

    expect(screen.queryByTestId('source-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('source-loading')).toBeInTheDocument();
  });

  it('blames its own request, not the dataset, when source health could not be loaded', () => {
    render(<SourceStrip sources={[]} failed />);

    const banner = screen.getByTestId('source-banner');

    expect(banner).not.toHaveTextContent(/no advisory data/i);
    expect(banner).toHaveTextContent(/source health could not be loaded/i);
  });

  it('carries the standing note about GHSA precedence', () => {
    render(<SourceStrip sources={HEALTHY} />);

    expect(screen.getByText(/GitHub Advisories first/i)).toBeInTheDocument();
  });
});
