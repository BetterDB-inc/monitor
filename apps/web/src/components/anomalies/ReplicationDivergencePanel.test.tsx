import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReplicationDivergencePanel, formatGap } from './ReplicationDivergencePanel';
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
    ];

    render(<ReplicationDivergencePanel replicas={replicas} />);

    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument();
    expect(screen.getByText('Diverging')).toBeInTheDocument();
    expect(screen.getByText('8.0 MiB')).toBeInTheDocument();
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(screen.getByText('Not catching up')).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getAllByText('collecting')).toHaveLength(2);
  });

  it('formats gap sizes across units', () => {
    expect(formatGap(512)).toBe('512 B');
    expect(formatGap(2048)).toBe('2.0 KiB');
    expect(formatGap(3 * 1024 ** 3)).toBe('3.0 GiB');
  });
});
