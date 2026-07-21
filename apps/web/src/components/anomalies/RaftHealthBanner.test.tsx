import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RaftHealthBanner, type RaftHealthEvent } from './RaftHealthBanner';
import { metricsApi } from '@/api/metrics';

vi.mock('@/api/metrics', () => ({
  metricsApi: {
    resolveAnomalyEvent: vi.fn().mockResolvedValue({ success: true }),
  },
}));

const raftEvent: RaftHealthEvent = {
  id: 'conn-1-raft-123',
  timestamp: 1700000000000,
  metricType: 'raft_health',
  severity: 'critical',
  message:
    'CRITICAL: Raft cluster has been leaderless for 12s (cluster_state:fail, role:pre-candidate). A majority of voting nodes is unreachable — the commit index is frozen and writes are refused until quorum is restored.',
  resolved: false,
};

describe('RaftHealthBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a critical banner with the event message and runbook', () => {
    render(<RaftHealthBanner events={[raftEvent]} />);

    expect(screen.getByText('Raft cluster has lost quorum')).toBeInTheDocument();
    expect(screen.getByText(raftEvent.message)).toBeInTheDocument();
    expect(screen.getByText('Remediation runbook')).toBeInTheDocument();
    expect(screen.getByText(/strict majority/)).toBeInTheDocument();
    expect(screen.getByText(/pre-vote protocol/)).toBeInTheDocument();
  });

  it('renders nothing when there are no events', () => {
    const { container } = render(<RaftHealthBanner events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when events is undefined', () => {
    const { container } = render(<RaftHealthBanner events={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores resolved events', () => {
    const { container } = render(
      <RaftHealthBanner events={[{ ...raftEvent, resolved: true }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores non-raft_health and non-critical events', () => {
    const { container } = render(
      <RaftHealthBanner
        events={[
          { ...raftEvent, id: 'e1', metricType: 'memory_used' },
          { ...raftEvent, id: 'e2', severity: 'warning' },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('resolves the event via the API and hides the banner on dismiss', async () => {
    render(<RaftHealthBanner events={[raftEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(raftEvent.id);
      expect(screen.queryByText('Raft cluster has lost quorum')).not.toBeInTheDocument();
    });
  });

  it('keeps the banner visible when the API reports success: false', async () => {
    vi.mocked(metricsApi.resolveAnomalyEvent).mockResolvedValueOnce({ success: false });
    render(<RaftHealthBanner events={[raftEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(raftEvent.id);
    });
    expect(screen.getByText('Raft cluster has lost quorum')).toBeInTheDocument();
  });

  it('keeps the banner visible when the resolve request throws', async () => {
    vi.mocked(metricsApi.resolveAnomalyEvent).mockRejectedValueOnce(new Error('network error'));
    render(<RaftHealthBanner events={[raftEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(raftEvent.id);
    });
    expect(screen.getByText('Raft cluster has lost quorum')).toBeInTheDocument();
  });
});
