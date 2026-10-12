import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { hasFeature } = vi.hoisted(() => ({ hasFeature: vi.fn() }));
vi.mock('../../hooks/useLicense', () => ({ useLicense: () => ({ hasFeature }) }));
vi.mock('../pages/cache-simulator', () => ({ CacheSimulatorProLocked: () => <div data-testid="locked" /> }));

import { CacheSimulatorGuard } from '../CacheSimulatorGuard';

describe('CacheSimulatorGuard', () => {
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
