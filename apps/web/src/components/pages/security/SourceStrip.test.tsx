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

  it('carries the standing note about GHSA precedence', () => {
    render(<SourceStrip sources={HEALTHY} />);

    expect(screen.getByText(/GitHub Advisories first/i)).toBeInTheDocument();
  });
});
