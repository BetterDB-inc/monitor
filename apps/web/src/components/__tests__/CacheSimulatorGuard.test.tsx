import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { hasFeature, state } = vi.hoisted(() => ({ hasFeature: vi.fn(), state: { loading: false } }));
vi.mock('../../hooks/useLicense', () => ({ useLicense: () => ({ hasFeature }), useLicenseStatus: () => ({ loading: state.loading }) }));
vi.mock('../pages/cache-simulator', () => ({ CacheSimulatorProLocked: () => <div data-testid="locked" /> }));

import { CacheSimulatorGuard } from '../CacheSimulatorGuard';

describe('CacheSimulatorGuard', () => {
  beforeEach(() => {
    state.loading = false;
  });

  it('shows neither the lock nor the page while the licence loads', () => {
    state.loading = true;
    hasFeature.mockReturnValue(false);
    render(<CacheSimulatorGuard><div data-testid="page" /></CacheSimulatorGuard>);
    expect(screen.queryByTestId('locked')).toBeNull();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('shows the Pro lock without the feature', () => {
    hasFeature.mockReturnValue(false);
    render(<CacheSimulatorGuard><div data-testid="page" /></CacheSimulatorGuard>);
    expect(screen.getByTestId('locked')).toBeTruthy();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('renders the page with the feature', () => {
    hasFeature.mockReturnValue(true);
    render(<CacheSimulatorGuard><div data-testid="page" /></CacheSimulatorGuard>);
    expect(screen.getByTestId('page')).toBeTruthy();
  });
});
