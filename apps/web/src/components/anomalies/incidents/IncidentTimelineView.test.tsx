import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { IncidentTimelineView } from './IncidentTimelineView';
import { entry, incident, T0 } from './incident-fixtures';

describe('IncidentTimelineView', () => {
  it('renders events in server order', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({ anomalyId: 'c', timestamp: T0, message: 'First' }),
            entry({ anomalyId: 'a', timestamp: T0, message: 'Second' }),
            entry({ anomalyId: 'b', timestamp: T0 + 1000, message: 'Last' }),
          ],
        })}
      />,
    );

    const messages = screen
      .getAllByTestId('incident-entry')
      .map((item) => within(item).getByText(/First|Second|Last/).textContent);
    expect(messages).toEqual(['First', 'Second', 'Last']);
  });

  it('shows each event recovery state', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({
              anomalyId: 'a',
              recoveredAt: T0 + 90_000,
              recoveryState: 'recovered',
              message: 'Recovered one',
            }),
            entry({ anomalyId: 'b', metricType: 'memory_used', message: 'Open one' }),
            entry({
              anomalyId: 'c',
              metricType: 'evicted_keys',
              recoveryState: 'unknown',
              message: 'Unknown one',
            }),
            entry({ anomalyId: 'd', recoveryState: 'recurred', message: 'Repeated one' }),
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
    expect(screen.getByText('Fired again later')).toBeInTheDocument();
  });

  it('does not mark an open event unknown when the same metric is unknown elsewhere', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({ anomalyId: 'a', nodeAddr: '10.0.0.1:6379', metricType: 'memory_used' }),
            entry({
              anomalyId: 'b',
              nodeAddr: '10.0.0.2:6379',
              metricType: 'memory_used',
              recoveryState: 'unknown',
            }),
          ],
          recovery: {
            status: 'recovering',
            openSignals: ['memory_used'],
            unknownSignals: ['memory_used'],
            recoveredAt: null,
          },
        })}
      />,
    );

    const [open, unknown] = screen.getAllByTestId('incident-entry');
    expect(within(open).getByText('Not back to baseline')).toBeInTheDocument();
    expect(within(unknown).getByText('Recovery unknown')).toBeInTheDocument();
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
              steps: [
                { anomalyId: 'a', step: 1 },
                { anomalyId: 'b', step: 2 },
              ],
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

  it('numbers events by their rule step and marks supporting signals', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          matchedPatterns: ['retry_storm'],
          entries: [
            entry({ anomalyId: 'a', metricType: 'command_p99' }),
            entry({ anomalyId: 'b', metricType: 'connection_churn', timestamp: T0 + 1 }),
            entry({ anomalyId: 'c', metricType: 'connections', timestamp: T0 + 2 }),
          ],
          sequenceMatches: [
            {
              pattern: 'retry_storm',
              anomalyIds: ['a', 'c', 'b'],
              steps: [
                { anomalyId: 'a', step: 2 },
                { anomalyId: 'c', step: 3 },
                { anomalyId: 'b', step: null },
              ],
              diagnosis: 'Clients are retrying slow commands',
              recommendations: [],
              severity: 'critical',
            },
          ],
        })}
      />,
    );

    const [first, second, third] = screen.getAllByTestId('incident-entry');
    expect(within(first).getByText('Step 2')).toBeInTheDocument();
    expect(within(second).getByText('Supporting signal')).toBeInTheDocument();
    expect(within(third).getByText('Step 3')).toBeInTheDocument();
  });

  it('shows computed values under the recommendations, and none when the match has none', () => {
    const match = {
      pattern: 'backlog_exhaustion',
      anomalyIds: ['a', 'b'],
      steps: [
        { anomalyId: 'a', step: 1 },
        { anomalyId: 'b', step: 2 },
      ],
      diagnosis: 'The backlog ran out',
      recommendations: ['Raise repl-backlog-size'],
      severity: 'critical' as const,
    };
    const entries = [
      entry({ anomalyId: 'a', metricType: 'backlog_coverage_risk' }),
      entry({ anomalyId: 'b', metricType: 'resync_escalation', timestamp: T0 + 1 }),
    ];
    const { unmount } = render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries,
          sequenceMatches: [
            {
              ...match,
              values: [{ setting: 'repl-backlog-size', current: 1, target: 9, unit: 'MB' }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Raise repl-backlog-size')).toBeInTheDocument();
    expect(screen.getByText('repl-backlog-size: 1 → 9 MB')).toBeInTheDocument();
    unmount();

    render(
      <IncidentTimelineView now={T0} incident={incident({ entries, sequenceMatches: [match] })} />,
    );
    expect(screen.getByText('Raise repl-backlog-size')).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('shows every rule step of an event that matched more than one rule', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          matchedPatterns: ['backlog_exhaustion', 'recovery_amplification'],
          entries: [
            entry({ anomalyId: 'a', metricType: 'repl_backlog' }),
            entry({ anomalyId: 'b', metricType: 'resync_escalation', timestamp: T0 + 1 }),
          ],
          sequenceMatches: [
            {
              pattern: 'backlog_exhaustion',
              anomalyIds: ['a', 'b'],
              steps: [
                { anomalyId: 'a', step: 1 },
                { anomalyId: 'b', step: 2 },
              ],
              diagnosis: 'Backlog ran out',
              recommendations: [],
              severity: 'warning',
            },
            {
              pattern: 'recovery_amplification',
              anomalyIds: ['b'],
              steps: [{ anomalyId: 'b', step: 1 }],
              diagnosis: 'Resync made it worse',
              recommendations: [],
              severity: 'warning',
            },
          ],
        })}
      />,
    );

    const [, second] = screen.getAllByTestId('incident-entry');
    expect(within(second).getByText('Backlog Exhaustion: Step 2')).toBeInTheDocument();
    expect(within(second).getByText('Recovery Amplification: Step 1')).toBeInTheDocument();
  });

  it('titles an incident without a pattern by its first signal', () => {
    render(<IncidentTimelineView now={T0} incident={incident()} />);
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
  });

  it('dates a recovery that falls on another day', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({
          entries: [
            entry({
              recoveredAt: T0 + 24 * 3_600_000,
              recoveryState: 'recovered',
            }),
          ],
        })}
      />,
    );
    const nextDay = new Date(T0 + 24 * 3_600_000).toLocaleString([], {
      month: 'short',
      day: 'numeric',
    });
    expect(screen.getByText(new RegExp(`Back to baseline at ${nextDay}`))).toBeInTheDocument();
  });

  it('dates event times when an incident crosses midnight', () => {
    const lateEvening = new Date(2026, 10, 5, 23, 55).getTime();
    const afterMidnight = new Date(2026, 10, 6, 0, 5).getTime();
    render(
      <IncidentTimelineView
        now={afterMidnight}
        incident={incident({
          startedAt: lateEvening,
          entries: [
            entry({ anomalyId: 'a', timestamp: lateEvening }),
            entry({ anomalyId: 'b', timestamp: afterMidnight }),
          ],
        })}
      />,
    );

    const nextDay = new Date(afterMidnight).toLocaleString([], { month: 'short', day: 'numeric' });
    const [, second] = screen.getAllByTestId('incident-entry');
    expect(within(second).getByText(new RegExp(nextDay))).toBeInTheDocument();
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
