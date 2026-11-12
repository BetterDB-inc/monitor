import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IncidentNotice } from './IncidentNotice';

describe('IncidentNotice', () => {
  it('renders the shared alert as a polite status by default', () => {
    render(<IncidentNotice>Showing the last list loaded.</IncidentNotice>);

    const notice = screen.getByRole('status');
    expect(notice).toHaveAttribute('data-slot', 'alert');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(notice.querySelector('[data-slot="alert-description"]')).toHaveTextContent(
      'Showing the last list loaded.',
    );
    expect(notice.querySelector('[data-slot="alert-title"]')).toBeNull();
  });

  it('interrupts as an alert when asked, with a title', () => {
    render(
      <IncidentNotice role="alert" title="Recovery debt">
        Memory is still away from baseline.
      </IncidentNotice>,
    );

    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('data-slot', 'alert');
    expect(notice.querySelector('[data-slot="alert-title"]')).toHaveTextContent('Recovery debt');
    expect(notice.querySelector('[data-slot="alert-description"]')).toHaveTextContent(
      'Memory is still away from baseline.',
    );
  });

  it('colours the warning icon through the alert so the shared icon rule cannot override it', () => {
    render(<IncidentNotice>Showing the last list loaded.</IncidentNotice>);

    const notice = screen.getByRole('status');
    expect(notice.className).toContain('*:[svg]:text-yellow-500');
    expect(notice.className).not.toContain('*:[svg]:text-current');
  });

  it('keeps action buttons inside the notice usable', () => {
    render(
      <IncidentNotice>
        <button type="button">Try again</button>
      </IncidentNotice>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
