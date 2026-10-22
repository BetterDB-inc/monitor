import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { refreshFootprint, conn } = vi.hoisted(() => ({ refreshFootprint: vi.fn(), conn: { id: 'c1' } }));

vi.mock('../useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: conn.id } }),
}));
vi.mock('../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { refreshFootprint } };
});

import { useRescanKvCache } from '../useRescanKvCache';

describe('useRescanKvCache', () => {
  it('refreshes the connection the rescan started on after the selection changes', async () => {
    let finish: (value: unknown) => void = () => undefined;
    refreshFootprint.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useRescanKvCache(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(refreshFootprint).toHaveBeenCalled());
    conn.id = 'c2';
    rerender();
    await act(async () => {
      finish(null);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(new Set(invalidate.mock.calls.map(([filters]) => (filters?.queryKey as unknown[])[2]))).toEqual(
      new Set(['c1']),
    );
  });
});
