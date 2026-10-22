import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThresholdsLink } from './ThresholdsLink';

const { state } = vi.hoisted(() => ({ state: { canMutate: true, licensed: true } }));

vi.mock('../../hooks/useCanMutate', () => ({ useCanMutate: () => state.canMutate }));
vi.mock('../../hooks/useLicense', () => ({
  useLicense: () => ({ tier: 'pro', license: null, hasFeature: () => state.licensed }),
}));

function renderLink(metricType: string, onParentClick = vi.fn()) {
  render(
    <MemoryRouter>
      <div onClick={onParentClick}>
        <ThresholdsLink metricType={metricType} />
      </div>
    </MemoryRouter>,
  );
  return onParentClick;
}

describe('ThresholdsLink', () => {
  beforeEach(() => {
    state.canMutate = true;
    state.licensed = true;
  });

  it('links an admin to the metric thresholds', () => {
    renderLink('connections');
    expect(screen.getByRole('link', { name: 'Thresholds' })).toHaveAttribute(
      'href',
      '/settings?section=anomaly&metric=connections',
    );
  });

  it('renders nothing for a metric without configurable thresholds', () => {
    renderLink('command_p99');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing for a non-admin', () => {
    state.canMutate = false;
    renderLink('connections');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing without the licence', () => {
    state.licensed = false;
    renderLink('connections');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not toggle the surrounding row when clicked', () => {
    const onParentClick = renderLink('connections');
    fireEvent.click(screen.getByRole('link', { name: 'Thresholds' }));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
