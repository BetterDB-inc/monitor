import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  threshold: 3,
  commands: ['hmget'],
};

function sustained(
  id: string,
  command: string,
  severity: string,
  threshold: number,
): LatencyRegressionEvent {
  return {
    id,
    timestamp: 1700000000000,
    metricType: 'command_p99',
    severity,
    message: `Sustained P99 latency degradation: ${command} p99 (${threshold.toFixed(1)}x).`,
    resolved: false,
    threshold,
    commands: [command],
  };
}

function lineCommands(): string[] {
  const list = screen.getAllByRole('list')[0];
  return within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.font-mono')?.textContent ?? '');
}

describe('LatencyRegressionBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the banner with the event message and a collapsed runbook', () => {
    render(<LatencyRegressionBanner events={[regressionEvent]} />);

    expect(screen.getByText('P99 latency regression on 1 command')).toBeInTheDocument();
    expect(screen.getByText(regressionEvent.message)).toBeInTheDocument();
    expect(screen.queryByText(/prefetch-batch-max-size/)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show remediation steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide remediation steps' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText(/prefetch-batch-max-size/)).toBeInTheDocument();
    expect(screen.getByText(/topology refresh interval/)).toBeInTheDocument();
  });

  it('renders one alert for several events, critical first, then by degradation factor', () => {
    render(
      <LatencyRegressionBanner
        events={[
          sustained('e1', 'cluster|nodes', 'warning', 2.0),
          sustained('e2', 'hget', 'critical', 5),
          sustained('e3', 'zadd', 'warning', 2.5),
        ]}
      />,
    );

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('P99 latency regression on 3 commands')).toBeInTheDocument();
    expect(lineCommands()).toEqual(['hget', 'zadd', 'cluster|nodes']);
    expect(screen.getAllByRole('button', { name: /mark resolved/i })).toHaveLength(3);
    expect(screen.queryByText(/prefetch-batch-max-size/)).not.toBeInTheDocument();
  });

  it('puts admin commands after data commands with a muted tag', () => {
    render(
      <LatencyRegressionBanner
        events={[
          sustained('e1', 'cluster|shards', 'critical', 4.6),
          sustained('e2', 'zadd', 'warning', 2.5),
        ]}
      />,
    );

    expect(lineCommands()).toEqual(['zadd', 'cluster|shards']);
    const tags = screen.getAllByText('monitoring/admin command');
    expect(tags).toHaveLength(1);
    expect(tags[0].closest('li')).toHaveTextContent('cluster|shards');
  });

  it('also renders warning-severity events (non-destructive variant)', () => {
    render(<LatencyRegressionBanner events={[{ ...regressionEvent, severity: 'warning' }]} />);
    expect(screen.getByText('P99 latency regression on 1 command')).toBeInTheDocument();
  });

  it('still renders older events that carry no commands', () => {
    render(
      <LatencyRegressionBanner
        events={[{ ...regressionEvent, commands: undefined, threshold: undefined }]}
      />,
    );
    expect(screen.getByText('P99 latency regression on 1 command')).toBeInTheDocument();
    expect(screen.getByText(regressionEvent.message)).toBeInTheDocument();
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

  it('resolves one line via the API and keeps the others', async () => {
    render(
      <LatencyRegressionBanner
        events={[sustained('e1', 'hget', 'critical', 5), sustained('e2', 'zadd', 'warning', 2.5)]}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /mark resolved/i })[0]);

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith('e1');
      expect(lineCommands()).toEqual(['zadd']);
    });
    expect(screen.getByText('P99 latency regression on 1 command')).toBeInTheDocument();
  });

  it('hides the banner once the last event is resolved', async () => {
    render(<LatencyRegressionBanner events={[regressionEvent]} />);

    fireEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => {
      expect(metricsApi.resolveAnomalyEvent).toHaveBeenCalledWith(regressionEvent.id);
      expect(screen.queryByText(/P99 latency regression on/)).not.toBeInTheDocument();
    });
  });
});
