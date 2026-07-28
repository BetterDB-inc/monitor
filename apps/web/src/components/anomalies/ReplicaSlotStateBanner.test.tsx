import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReplicaSlotStateBanner, type ReplicaSlotStateEvent } from './ReplicaSlotStateBanner';
import { metricsApi } from '@/api/metrics';

vi.mock('@/api/metrics', () => ({
  metricsApi: {
    resolveAnomalyEvent: vi.fn().mockResolvedValue({ success: true }),
  },
}));

const slotEvent: ReplicaSlotStateEvent = {
  id: 'conn-1-replica-slot-state-repB-123',
  timestamp: 1700000000000,
  metricType: 'replica_slot_state',
  severity: 'warning',
  message:
    'WARNING: Replica 10.0.0.2:6380 (repB12345) is reporting slot(s) 42 in IMPORTING state — replicas must never carry slot-migration state, so this is a stuck, inconsistent cluster state (valkey#1664). Run `CLUSTER SETSLOT 42 STABLE` on 10.0.0.2:6380 to clear the stuck slot state.',
  resolved: false,
};

describe('ReplicaSlotStateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a warning banner with the event message and runbook', () => {
    render(<ReplicaSlotStateBanner events={[slotEvent]} />);

    expect(screen.getByText('Replica slot-state inconsistency (valkey#1664)')).toBeInTheDocument();
    expect(screen.getByText(slotEvent.message)).toBeInTheDocument();
    expect(screen.getByText('Remediation runbook')).toBeInTheDocument();
    // "SETSLOT" appears in both the message and the runbook step.
    expect(screen.getAllByText(/SETSLOT/).length).toBeGreaterThan(0);
    // The runbook must cover BOTH remediations so it can't contradict a
    // divergence event (which says to use CLUSTER REPLICATE, not SETSLOT).
    expect(screen.getByText(/CLUSTER REPLICATE/)).toBeInTheDocument();
  });

  it('renders nothing when there are no events', () => {
    const { container } = render(<ReplicaSlotStateBanner events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when events is undefined', () => {
    const { container } = render(<ReplicaSlotStateBanner events={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores resolved events', () => {
    const { container } = render(
      <ReplicaSlotStateBanner events={[{ ...slotEvent, resolved: true }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores events of other metric types', () => {
    const { container } = render(
      <ReplicaSlotStateBanner events={[{ ...slotEvent, id: 'e1', metricType: 'memory_used' }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('resolves the event via the API and hides the banner on dismiss', async () => {
    render(<ReplicaSlotStateBanner events={[slotEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(slotEvent.id);
      expect(
        screen.queryByText('Replica slot-state inconsistency (valkey#1664)'),
      ).not.toBeInTheDocument();
    });
  });

  it('keeps the banner visible when the API reports success: false', async () => {
    vi.mocked(metricsApi.resolveAnomalyEvent).mockResolvedValueOnce({ success: false });
    render(<ReplicaSlotStateBanner events={[slotEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(slotEvent.id);
    });
    expect(screen.getByText('Replica slot-state inconsistency (valkey#1664)')).toBeInTheDocument();
  });
});
