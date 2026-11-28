import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import { ApiError } from '../api/client';
import { placementQueryKey, usePlacement } from './usePlacement';

const mocks = vi.hoisted(() => ({ setPolicy: vi.fn() }));

vi.mock('../api/placement', () => ({
  placementApi: { get: vi.fn(), setMode: vi.fn(), setPolicy: mocks.setPolicy },
}));
vi.mock('./useLicense', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('./usePolling', () => ({ usePolling: () => ({ data: undefined, error: null }) }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => usePlacement('conn-a'), { wrapper });
  return { result, invalidate };
}

describe('usePlacement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the placement status again when a save meets a newer version', async () => {
    mocks.setPolicy.mockRejectedValue(
      new ApiError('stale', 409, { message: 'stale', reason: 'version_conflict' }),
    );
    const { result, invalidate } = setup();

    await expect(result.current.savePolicy(DEFAULT_PLACEMENT_SETTINGS, 3)).rejects.toThrow();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: placementQueryKey('conn-a') });
  });

  it('leaves the placement status alone when a save fails for another reason', async () => {
    mocks.setPolicy.mockRejectedValue(new ApiError('bad', 400, { errors: ['bad'] }));
    const { result, invalidate } = setup();

    await expect(result.current.savePolicy(DEFAULT_PLACEMENT_SETTINGS, 3)).rejects.toThrow();

    expect(invalidate).not.toHaveBeenCalled();
  });
});
