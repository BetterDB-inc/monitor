import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NavItem } from './NavItem';

function renderItem(to: string) {
  return render(
    <MemoryRouter>
      <NavItem to={to} active={false}>
        {to}
      </NavItem>
    </MemoryRouter>,
  );
}

describe('NavItem shortcut hint', () => {
  it('renders the chord for a route that has one', () => {
    renderItem('/slowlog');

    expect(screen.getByText('G S')).toBeInTheDocument();
  });

  it('renders nothing extra for a route with no chord', () => {
    renderItem('/not-a-bound-route');

    expect(screen.queryByRole('link')?.textContent).toBe('/not-a-bound-route');
  });

  it('renders the chord that actually navigates, not a hand-written one', () => {
    // The hint reads from the same table the binding registers from, so a
    // changed chord updates both or neither.
    renderItem('/cluster');

    expect(screen.getByText('G U')).toBeInTheDocument();
  });

  it('keeps the chord in the accessibility tree rather than removing it', () => {
    // Hidden by opacity, not by display — a screen reader should still be able
    // to announce the shortcut even though it is only drawn on hover.
    renderItem('/slowlog');

    expect(screen.getByText('G S')).toBeVisible();
  });
});
