import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FanoutCoverageNotice } from './FanoutCoverageNotice';
import { PaymentRequiredError } from '@/api/client';
import type { FanoutCoverage } from '@/types/anomaly';

const NOW = 1700000000000;

function coverage(overrides: Partial<FanoutCoverage>): FanoutCoverage {
  return {
    connectionId: 'conn-1',
    topology: 'cluster',
    checked: 0,
    unreachable: 0,
    authFailed: 0,
    skipped: 0,
    notDialed: 0,
    reason: null,
    tunnelled: false,
    targetLimit: 64,
    timeoutMs: 2000,
    timestamp: NOW,
    ageMs: 0,
    stale: false,
    ...overrides,
  };
}

describe('FanoutCoverageNotice', () => {
  function at(now: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  }

  beforeEach(() => at(NOW));
  afterEach(() => vi.useRealTimers());

  it('tells a Sentinel connection without data-node credentials what to set', () => {
    render(
      <FanoutCoverageNotice
        coverage={coverage({ topology: 'sentinel', reason: 'no_sentinel_credentials', notDialed: 3 })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Sentinel data nodes not covered');
    expect(screen.getByRole('alert')).toHaveTextContent('none of the 3 primaries the Sentinel monitors');
    expect(screen.getByText('nodeUsername')).toBeInTheDocument();
    expect(screen.getByText('nodePassword')).toBeInTheDocument();
    expect(screen.getByText('Connect to data nodes without a username')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('then delete this connection');
  });

  it('names a data-node password that cannot be decrypted', () => {
    render(
      <FanoutCoverageNotice
        coverage={coverage({ topology: 'sentinel', reason: 'sentinel_credentials_unreadable' })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('could not be decrypted');
    expect(screen.getByText('ENCRYPTION_KEY')).toBeInTheDocument();
    expect(screen.queryByText('Connect to data nodes without a username')).not.toBeInTheDocument();
  });

  it('points a certificate-auth Sentinel at the API instead of the form', () => {
    render(<FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', reason: 'certificate_auth' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('certificate auth');
    expect(screen.getByText('POST /api/connections')).toBeInTheDocument();
    expect(screen.queryByText('Connect to data nodes without a username')).not.toBeInTheDocument();
  });

  it('does not offer credentials as the fix for an agent connection', () => {
    render(<FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', reason: 'agent_connection' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('through the agent');
    expect(screen.queryByText('nodePassword')).not.toBeInTheDocument();
  });

  it('names the SSH tunnel rather than the credentials', () => {
    render(<FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', reason: 'ssh_tunnel' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('SSH tunnel');
    expect(screen.queryByText('nodePassword')).not.toBeInTheDocument();
  });

  it('does not call an agent-connected cluster a Sentinel', () => {
    render(<FanoutCoverageNotice coverage={coverage({ reason: 'agent_connection', notDialed: 2 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Other primaries not covered');
    expect(screen.getByRole('alert')).toHaveTextContent('the cluster reports');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Sentinel');
  });

  it('says SENTINEL MASTERS has not been read yet', () => {
    render(<FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', reason: 'topology_unknown' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Other primaries not checked yet');
  });

  it.each([
    ['sentinel', 'SENTINEL MASTERS'],
    ['cluster', 'CLUSTER NODES'],
  ] as const)('says the %s topology read failed rather than not started', (topology, command) => {
    render(<FanoutCoverageNotice coverage={coverage({ topology, reason: 'topology_unreadable' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent(`${command} failed on the latest poll`);
    expect(screen.getByRole('alert')).not.toHaveTextContent('not been read yet');
  });

  it('counts the primaries checked, unreachable, refused and past the cap', () => {
    render(
      <FanoutCoverageNotice
        coverage={coverage({ checked: 3, unreachable: 2, authFailed: 1, skipped: 1, targetLimit: 32, timeoutMs: 5000 })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '3 of 7 primaries checked (2 unreachable, 1 refused the credentials, 1 past the 32-primary cap)',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('within 5 seconds');
    expect(screen.getByRole('alert')).toHaveTextContent('WRONGPASS, NOAUTH or NOPERM');
    expect(screen.getByRole('alert')).toHaveTextContent('register one of them');
  });

  it('tells a Sentinel past the cap to add another Sentinel, not a primary', () => {
    render(<FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', checked: 64, skipped: 6 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('add another Sentinel of this deployment');
    expect(screen.getByRole('alert')).not.toHaveTextContent('register one of them');
  });

  it('leaves out the gap it does not have', () => {
    render(<FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('3 of 5 primaries checked (2 unreachable)');
    expect(screen.getByRole('alert')).not.toHaveTextContent('past the');
    expect(screen.getByRole('alert')).not.toHaveTextContent('refused');
  });

  it('shows the server-side age of coverage no poll has refreshed lately', () => {
    // A browser clock an hour off does not change it.
    at(NOW + 3_600_000);
    render(<FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2, ageMs: 25_000 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Last checked 25 seconds ago');
  });

  it('does not show the age of fresh coverage', () => {
    at(NOW + 3_600_000);
    render(<FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2, ageMs: 2_000 })} />);

    expect(screen.getByRole('alert')).not.toHaveTextContent('Last checked');
  });

  it('warns that stale coverage may hide stopped checks, even when it was full', () => {
    render(<FanoutCoverageNotice coverage={coverage({ checked: 4, ageMs: 90_000, stale: true })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Fan-out coverage is out of date');
    expect(screen.getByRole('alert')).toHaveTextContent('Last checked 90 seconds ago');
  });

  it('says when coverage could not be loaded at all', () => {
    render(<FanoutCoverageNotice coverage={undefined} error={new Error('Network error')} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Fan-out coverage could not be loaded');
    expect(screen.getByRole('alert')).toHaveTextContent('is not known');
  });

  it('keeps the last coverage, marked as possibly out of date, when a refresh fails', () => {
    render(
      <FanoutCoverageNotice coverage={coverage({ checked: 3, unreachable: 2 })} error={new Error('Network error')} />,
    );

    const [failure, notice] = screen.getAllByRole('alert');
    expect(failure).toHaveTextContent('may be out of date');
    expect(notice).toHaveTextContent('3 of 5 primaries checked');
  });

  it('does not report a missing license as a failure', () => {
    const { container } = render(
      <FanoutCoverageNotice coverage={undefined} error={new PaymentRequiredError({
            message: 'license required',
            feature: 'anomalyDetection',
            currentTier: 'community',
            requiredTier: 'pro',
            upgradeUrl: '',
          })} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('names other stored secrets that failed to decrypt', () => {
    render(
      <FanoutCoverageNotice coverage={coverage({ topology: 'sentinel', reason: 'connection_secrets_unreadable' })} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('another stored secret');
  });

  it('says the cycle failed before it read the primaries', () => {
    render(<FanoutCoverageNotice coverage={coverage({ reason: 'fanout_failed', notDialed: 2 })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('failed before it read the primaries');
    expect(screen.getByRole('alert')).toHaveTextContent('none of the 2 primaries');
  });

  it('explains unreachable primaries of an SSH-tunnelled cluster', () => {
    render(<FanoutCoverageNotice coverage={coverage({ checked: 1, unreachable: 2, tunnelled: true })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('outside it');
  });

  it('does not mention the tunnel when every primary answers', () => {
    render(<FanoutCoverageNotice coverage={coverage({ checked: 1, skipped: 1, tunnelled: true })} />);

    expect(screen.getByRole('alert')).not.toHaveTextContent('SSH tunnel');
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
