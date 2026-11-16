import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TimelineAnomalyRow, type TimelineAnomalyItem } from './TimelineAnomalyRow';

const ITEM: TimelineAnomalyItem = {
  timestamp: Date.now() - 60_000,
  severity: 'critical',
  metricType: 'replication_lag',
  zScore: 4.25,
};

function renderRow(item: TimelineAnomalyItem) {
  render(
    <MemoryRouter>
      <table>
        <tbody>
          <TimelineAnomalyRow item={item} age="1m ago" />
        </tbody>
      </table>
    </MemoryRouter>,
  );
}

describe('TimelineAnomalyRow', () => {
  it('shows the severity, the metric and the z-score', () => {
    renderRow(ITEM);

    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('replication_lag')).toBeInTheDocument();
    expect(screen.getByText('z: 4.25')).toBeInTheDocument();
    expect(screen.getByText('1m ago')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links to the node the anomaly is on', () => {
    renderRow({
      ...ITEM,
      connectionId: 'conn-1',
      node: { nodeId: 'n1', address: '10.0.0.2:6379', role: 'replica', collected: false },
    });

    expect(screen.getByRole('link', { name: '10.0.0.2:6379' })).toHaveAttribute(
      'href',
      '/cluster?tab=nodes&node=n1&connection=conn-1',
    );
    expect(screen.getByText('Not collected')).toBeInTheDocument();
  });
});
