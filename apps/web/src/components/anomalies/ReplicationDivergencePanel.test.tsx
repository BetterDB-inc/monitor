import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReplicationDivergencePanel, formatGap } from './ReplicationDivergencePanel';
import { PaymentRequiredError } from '@/api/client';
import type { ReplicaDivergenceHistory } from '@/types/anomaly';

const MiB = 1024 * 1024;

const window = (gapBytes: number, secondsBehind: number | null) => ({
  start: 0,
  end: 30_000,
  gapBytes,
  bytesPerSec: secondsBehind === null ? null : MiB,
  secondsBehind,
});

describe('ReplicationDivergencePanel', () => {
  it('renders nothing without replicas', () => {
    const { container } = render(<ReplicationDivergencePanel replicas={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each replica with its level, latest gap and seconds behind', () => {
    const replicas: ReplicaDivergenceHistory[] = [
      {
        replica: '10.0.0.2:6379',
        level: 'warning',
        latest: window(8 * MiB, 8),
        windows: [window(2 * MiB, 2), window(8 * MiB, 8)],
      },
      {
        replica: '10.0.0.3:6379',
        level: 'critical',
        latest: window(4 * MiB, null),
        windows: [window(4 * MiB, null)],
      },
      { replica: '10.0.0.4:6379', level: 'none', latest: null, windows: [] },
      { replica: '10.0.0.5:6379', level: 'unobserved', latest: null, windows: [] },
    ];

    render(<ReplicationDivergencePanel replicas={replicas} />);

    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument();
    expect(screen.getByText('Diverging')).toBeInTheDocument();
    expect(screen.getByText('8.0 MiB')).toBeInTheDocument();
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(screen.getByText('Not catching up')).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('Not observed')).toBeInTheDocument();
    expect(screen.getAllByText('collecting')).toHaveLength(3);
  });

  it('says so when the history could not be loaded', () => {
    render(<ReplicationDivergencePanel replicas={undefined} error={new Error('boom')} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Replication history could not be loaded');
  });

  it('stays hidden when the feature is not licensed', () => {
    const { container } = render(
      <ReplicationDivergencePanel
        replicas={undefined}
        error={
          new PaymentRequiredError({
            message: 'upgrade',
            feature: 'anomalyDetection',
            currentTier: 'community',
            requiredTier: 'pro',
            upgradeUrl: '/upgrade',
          })
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('hides cached replicas when a refresh loses the license', () => {
    const { container } = render(
      <ReplicationDivergencePanel
        replicas={[{ replica: '10.0.0.2:6379', level: 'none', latest: null, windows: [] }]}
        error={
          new PaymentRequiredError({
            message: 'upgrade',
            feature: 'anomalyDetection',
            currentTier: 'community',
            requiredTier: 'pro',
            upgradeUrl: '/upgrade',
          })
        }
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the last loaded replicas and flags them when a refresh fails', () => {
    const replicas: ReplicaDivergenceHistory[] = [
      { replica: '10.0.0.2:6379', level: 'none', latest: null, windows: [] },
    ];

    render(<ReplicationDivergencePanel replicas={replicas} error={new Error('boom')} />);

    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('formats gap sizes across units', () => {
    expect(formatGap(512)).toBe('512 B');
    expect(formatGap(2048)).toBe('2.0 KiB');
    expect(formatGap(3 * 1024 ** 3)).toBe('3.0 GiB');
  });
});
