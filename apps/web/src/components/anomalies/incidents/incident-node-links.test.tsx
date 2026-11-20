import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ServedClusterNodeRef } from '@betterdb/shared';
import { IncidentList } from './IncidentList';
import { IncidentTimelineView } from './IncidentTimelineView';
import { entry, incident, T0 } from './incident-fixtures';

function node(at: number, overrides: Partial<ServedClusterNodeRef> = {}): ServedClusterNodeRef {
  return {
    nodeId: `n${at}`,
    address: `10.0.0.${at}:6379`,
    role: 'primary',
    collected: true,
    connectionId: `conn-n${at}`,
    ...overrides,
  };
}

describe('IncidentTimelineView node links', () => {
  it('links each event to the node it is on', () => {
    render(
      <MemoryRouter>
        <IncidentTimelineView
          now={T0}
          incident={incident({
            entries: [
              entry({ anomalyId: 'a', nodeAddr: '10.0.0.1:6379', node: node(1) }),
              entry({
                anomalyId: 'b',
                connectionId: 'conn-2',
                nodeAddr: '10.0.0.2:6379',
                node: node(2, { collected: false, connectionId: undefined }),
              }),
            ],
          })}
        />
      </MemoryRouter>,
    );

    const [first, second] = screen.getAllByTestId('incident-entry');
    expect(within(first).getByRole('link', { name: '10.0.0.1:6379' })).toHaveAttribute(
      'href',
      '/cluster?tab=nodes&node=n1&connection=conn-1',
    );
    expect(within(first).queryByText('Not collected')).not.toBeInTheDocument();
    expect(within(second).getByRole('link', { name: '10.0.0.2:6379' })).toHaveAttribute(
      'href',
      '/cluster?tab=nodes&node=n2&connection=conn-2',
    );
    expect(within(second).getByText('Not collected')).toBeInTheDocument();
  });

  it('keeps the plain address of an event whose node is not known', () => {
    render(
      <IncidentTimelineView
        now={T0}
        incident={incident({ entries: [entry({ nodeAddr: '10.0.0.9:6379' })] })}
      />,
    );

    expect(screen.getByText('10.0.0.9:6379')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '10.0.0.9:6379' })).not.toBeInTheDocument();
  });
});

describe('IncidentList node links', () => {
  function renderList(entries: ReturnType<typeof entry>[]) {
    render(
      <MemoryRouter>
        <IncidentList now={T0} incidents={[incident({ entries })]} />
      </MemoryRouter>,
    );
  }

  it('links each node of an incident once', () => {
    renderList([
      entry({ anomalyId: 'a', nodeAddr: '10.0.0.1:6379', node: node(1) }),
      entry({ anomalyId: 'b', nodeAddr: '10.0.0.1:6379', node: node(1) }),
      entry({ anomalyId: 'c', nodeAddr: '10.0.0.2:6379', node: node(2) }),
    ]);

    expect(screen.getAllByRole('link', { name: '10.0.0.1:6379' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: '10.0.0.2:6379' })).toHaveAttribute(
      'href',
      '/cluster?tab=nodes&node=n2&connection=conn-1',
    );
  });

  it('links the first three nodes and counts the rest', () => {
    renderList([1, 2, 3, 4, 5].map((at) => entry({ anomalyId: `e${at}`, node: node(at) })));

    expect(screen.getAllByRole('link', { name: /10\.0\.0\.\d:6379/ })).toHaveLength(3);
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
  });

  it('shows no node link for an incident without a known node', () => {
    renderList([entry({ nodeAddr: '10.0.0.9:6379' })]);

    expect(screen.queryByRole('link', { name: /6379/ })).not.toBeInTheDocument();
  });
});
