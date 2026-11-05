import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { IncidentTimelineView } from './IncidentTimelineView';
import { entry, incident, T0 } from './incident-fixtures';

describe('IncidentTimelineView', () => {
  it('renders events with equal timestamps in server order', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({ anomalyId: 'b', timestamp: T0 + 1000, message: 'Last' }),
            entry({ anomalyId: 'c', timestamp: T0, message: 'First' }),
            entry({ anomalyId: 'a', timestamp: T0, message: 'Second' }),
          ],
        })}
      />,
    );

    const messages = screen
      .getAllByTestId('incident-entry')
      .map((item) => within(item).getByText(/First|Second|Last/).textContent);
    expect(messages).toEqual(['First', 'Second', 'Last']);
  });

  it('shows when each signal returned to baseline', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({ anomalyId: 'a', recoveredAt: T0 + 90_000, message: 'Recovered one' }),
            entry({ anomalyId: 'b', metricType: 'memory_used', message: 'Open one' }),
            entry({ anomalyId: 'c', metricType: 'evicted_keys', message: 'Unknown one' }),
          ],
          recovery: {
            status: 'active',
            openSignals: ['memory_used'],
            unknownSignals: ['evicted_keys'],
            recoveredAt: null,
          },
        })}
      />,
    );

    expect(screen.getByText(/Back to baseline at .* \(after 1m 30s\)/)).toBeInTheDocument();
    expect(screen.getByText('Not back to baseline')).toBeInTheDocument();
    expect(screen.getByText('Recovery unknown')).toBeInTheDocument();
  });

  it('highlights the matched sequence rule and its steps', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          matchedPatterns: ['retry_storm'],
          entries: [
            entry({ anomalyId: 'a', metricType: 'command_p99', message: 'Latency up' }),
            entry({
              anomalyId: 'b',
              metricType: 'connection_churn',
              timestamp: T0 + 1,
              message: 'Churn up',
            }),
          ],
          sequenceMatches: [
            {
              pattern: 'retry_storm',
              anomalyIds: ['a', 'b'],
              diagnosis: 'Clients are retrying slow commands',
              recommendations: ['Add client backoff'],
              severity: 'critical',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Matched sequence: Retry Storm')).toBeInTheDocument();
    expect(screen.getByText('Clients are retrying slow commands')).toBeInTheDocument();
    expect(screen.getByText('Add client backoff')).toBeInTheDocument();
    const [first, second] = screen.getAllByTestId('incident-entry');
    expect(within(first).getByText('Step 1')).toBeInTheDocument();
    expect(within(second).getByText('Step 2')).toBeInTheDocument();
  });

  it('calls out recovery debt on a degraded incident', () => {
    render(
      <IncidentTimelineView
        now={T0 + 3_600_000}
        incident={incident({
          entries: [entry({ metricType: 'memory_used' })],
          recovery: {
            status: 'degraded',
            openSignals: ['memory_used'],
            unknownSignals: [],
            recoveredAt: null,
          },
        })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Recovery debt');
    expect(alert).toHaveTextContent('Memory is still away from baseline.');
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('does not show recovery debt once recovered', () => {
    render(<IncidentTimelineView now={T0} incident={incident()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
