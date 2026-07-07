import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataLossAlertBanner, type DataLossEvent } from './DataLossAlertBanner';
import { metricsApi } from '@/api/metrics';

vi.mock('@/api/metrics', () => ({
  metricsApi: {
    resolveAnomalyEvent: vi.fn().mockResolvedValue({ success: true }),
  },
}));

const dataLossEvent: DataLossEvent = {
  id: 'conn-1-dataloss-123',
  timestamp: 1700000000000,
  metricType: 'dataset_keys',
  severity: 'critical',
  message:
    'CRITICAL: Primary restarted with an empty dataset (replid changed, 150 keys → 0). Connected replicas (1) will full-resync and WIPE their copies. Immediate action: detach replicas that still hold data (REPLICAOF NO ONE) before they resync, then restore.',
  resolved: false,
};

describe('DataLossAlertBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a critical banner with the event message and runbook', () => {
    render(<DataLossAlertBanner events={[dataLossEvent]} />);

    expect(screen.getByText('Data loss detected')).toBeInTheDocument();
    expect(screen.getByText(dataLossEvent.message)).toBeInTheDocument();
    expect(screen.getByText('Remediation runbook')).toBeInTheDocument();
    // Appears in both the event message and the runbook step
    expect(screen.getAllByText(/REPLICAOF NO ONE/).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/Safety of replication when master has persistence turned off/),
    ).toBeInTheDocument();
  });

  it('renders nothing when there are no events', () => {
    const { container } = render(<DataLossAlertBanner events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when events is undefined', () => {
    const { container } = render(<DataLossAlertBanner events={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores resolved events', () => {
    const { container } = render(
      <DataLossAlertBanner events={[{ ...dataLossEvent, resolved: true }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores non-dataset_keys and non-critical events', () => {
    const { container } = render(
      <DataLossAlertBanner
        events={[
          { ...dataLossEvent, id: 'e1', metricType: 'memory_used' },
          { ...dataLossEvent, id: 'e2', severity: 'warning' },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('resolves the event via the API and hides the banner on dismiss', async () => {
    render(<DataLossAlertBanner events={[dataLossEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(dataLossEvent.id);
      expect(screen.queryByText('Data loss detected')).not.toBeInTheDocument();
    });
  });

  it('keeps the banner visible when the API reports success: false', async () => {
    vi.mocked(metricsApi.resolveAnomalyEvent).mockResolvedValueOnce({ success: false });
    render(<DataLossAlertBanner events={[dataLossEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(dataLossEvent.id);
    });
    expect(screen.getByText('Data loss detected')).toBeInTheDocument();
  });

  it('keeps the banner visible when the resolve request throws', async () => {
    vi.mocked(metricsApi.resolveAnomalyEvent).mockRejectedValueOnce(new Error('network error'));
    render(<DataLossAlertBanner events={[dataLossEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(dataLossEvent.id);
    });
    expect(screen.getByText('Data loss detected')).toBeInTheDocument();
  });
});
