import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const findIncidentByEvent = vi.fn();

vi.mock('../../../api/metrics', () => ({
  metricsApi: { findIncidentByEvent: (...args: unknown[]) => findIncidentByEvent(...args) },
}));

import { GroupIncidentLink, type IncidentGroupMember } from './GroupIncidentLink';

const member = (overrides: Partial<IncidentGroupMember>): IncidentGroupMember => ({
  id: 'a',
  timestamp: 1000,
  ...overrides,
});

const group = (anomalies: IncidentGroupMember[]) => ({ anomalies });

function renderLink(value: { anomalies: IncidentGroupMember[] }) {
  return render(
    <MemoryRouter initialEntries={['/anomalies?connection=conn-1']}>
      <GroupIncidentLink group={value} />
    </MemoryRouter>,
  );
}

describe('GroupIncidentLink', () => {
  it('links to the incident of the earliest member event', () => {
    renderLink(
      group([
        member({ id: 'b', timestamp: 2000, connectionId: 'conn-2' }),
        member({ id: 'a', timestamp: 1000, connectionId: 'conn-9' }),
      ]),
    );

    expect(screen.getByRole('link', { name: 'View incident' })).toHaveAttribute(
      'href',
      '/anomalies/incidents/by-event/a?at=1000&connection=conn-9',
    );
  });

  it('shows no link for a group without loaded events', () => {
    renderLink(group([]));

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('makes no request while it is shown', () => {
    const value = group([member({})]);
    const view = renderLink(value);
    view.rerender(
      <MemoryRouter>
        <GroupIncidentLink group={value} />
      </MemoryRouter>,
    );

    expect(findIncidentByEvent).not.toHaveBeenCalled();
  });
});
