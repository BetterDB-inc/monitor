import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LatencyRegressionBanner, type LatencyRegressionEvent } from './LatencyRegressionBanner';
import { metricsApi } from '@/api/metrics';

vi.mock('@/api/metrics', () => ({
  metricsApi: {
    resolveAnomalyEvent: vi.fn().mockResolvedValue({ success: true }),
  },
}));

const regressionEvent: LatencyRegressionEvent = {
  id: 'conn-1-p99-123',
  timestamp: 1700000000000,
  metricType: 'command_p99',
  severity: 'critical',
  message:
    'P99 latency regression after upgrade 8.1.0 -> 9.0.0: hmget p99 6.0ms (baseline 2.0ms, 3.0x).',
  resolved: false,
};

describe('LatencyRegressionBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the banner with the event message and runbook', () => {
    render(<LatencyRegressionBanner events={[regressionEvent]} />);

    expect(screen.getByText('P99 latency regression detected')).toBeInTheDocument();
    expect(screen.getByText(regressionEvent.message)).toBeInTheDocument();
    expect(screen.getByText('Remediation runbook')).toBeInTheDocument();
    expect(screen.getByText(/prefetch-batch-max-size/)).toBeInTheDocument();
    expect(screen.getByText(/topology refresh interval/)).toBeInTheDocument();
  });

  it('also renders warning-severity events (non-destructive variant)', () => {
    render(
      <LatencyRegressionBanner events={[{ ...regressionEvent, severity: 'warning' }]} />,
    );
    expect(screen.getByText('P99 latency regression detected')).toBeInTheDocument();
  });

  it('renders nothing when there are no events', () => {
    const { container } = render(<LatencyRegressionBanner events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when events is undefined', () => {
    const { container } = render(<LatencyRegressionBanner events={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores resolved events and other metric types', () => {
    const { container } = render(
      <LatencyRegressionBanner
        events={[
          { ...regressionEvent, id: 'e1', resolved: true },
          { ...regressionEvent, id: 'e2', metricType: 'dataset_keys' },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('resolves the event via the API and hides the banner on dismiss', async () => {
    render(<LatencyRegressionBanner events={[regressionEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(regressionEvent.id);
      expect(screen.queryByText('P99 latency regression detected')).not.toBeInTheDocument();
    });
  });
});
