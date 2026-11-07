import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FanoutCoverageNotice } from './FanoutCoverageNotice';
import type { FanoutCoverage } from '@/types/anomaly';

function coverage(overrides: Partial<FanoutCoverage>): FanoutCoverage {
  return {
    connectionId: 'conn-1',
    checked: 0,
    unreachable: 0,
    skipped: 0,
    reason: null,
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe('FanoutCoverageNotice', () => {
  it('tells a Sentinel connection without data-node credentials what to set', () => {
    render(<FanoutCoverageNotice coverage={coverage({ reason: 'no_sentinel_credentials' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Sentinel data nodes not covered');
    expect(screen.getByText('nodeUsername')).toBeInTheDocument();
    expect(screen.getByText('nodePassword')).toBeInTheDocument();
    expect(screen.getByText('Connect to data nodes without a username')).toBeInTheDocument();
  });

  it('names the SSH tunnel rather than the credentials', () => {
    render(<FanoutCoverageNotice coverage={coverage({ reason: 'ssh_tunnel' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('SSH tunnel');
    expect(screen.queryByText('nodePassword')).not.toBeInTheDocument();
  });

  it('says the topology has not been read yet', () => {
    render(<FanoutCoverageNotice coverage={coverage({ reason: 'topology_unknown' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Other primaries not checked yet');
  });

  it('counts the primaries checked, unreachable and past the cap', () => {
    render(
      <FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2, skipped: 1 })} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '3 of 6 primaries checked (2 unreachable, 1 past the 64-primary cap)',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('retry backoff');
    expect(screen.getByRole('alert')).toHaveTextContent('register one of them');
  });

  it('leaves out the gap it does not have', () => {
    render(<FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('3 of 5 primaries checked (2 unreachable)');
    expect(screen.getByRole('alert')).not.toHaveTextContent('past the cap');
  });

  it.each([
    ['full coverage', coverage({ checked: 4 })],
    ['a standalone connection', coverage({ reason: 'not_applicable' })],
    ['every primary registered on its own', coverage({ reason: 'no_targets' })],
    ['primaries checked by another connection', coverage({ reason: 'covered_elsewhere' })],
    ['no coverage yet', undefined],
    ['no entry for the connection', null],
  ])('renders nothing for %s', (_case, value) => {
    const { container } = render(<FanoutCoverageNotice coverage={value} />);

    expect(container).toBeEmptyDOMElement();
  });
});
