import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GroupIncidentLink } from './GroupIncidentLink';

function renderLink(incidentId: string | undefined) {
  return render(
    <MemoryRouter>
      <GroupIncidentLink incidentId={incidentId} linkQuery="start=1&end=2&from=overview" />
    </MemoryRouter>,
  );
}

describe('GroupIncidentLink', () => {
  it('links to the incident stored on the group', () => {
    renderLink('100-abc');

    expect(screen.getByRole('link', { name: 'View incident timeline' })).toHaveAttribute(
      'href',
      '/anomalies/incidents/100-abc?start=1&end=2&from=overview',
    );
  });

  it('shows no link for a group without an incident', () => {
    renderLink(undefined);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
