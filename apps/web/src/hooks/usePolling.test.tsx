import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('./useUpgradePrompt', () => ({ useUpgradePrompt: () => ({ showUpgradePrompt: vi.fn() }) }));

import { usePolling } from './usePolling';

function renderPolling(keepPreviousData?: (previousKey: string | number | undefined) => boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let release: (value: string) => void = () => undefined;
  const fetcher = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce('first')
    .mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
  const hook = renderHook(
    ({ refetchKey }: { refetchKey: string }) =>
      usePolling<string>({ fetcher, interval: () => false, refetchKey, keepPreviousData }),
    { wrapper, initialProps: { refetchKey: 'conn-1:1' } },
  );
  return { ...hook, release: (value: string) => release(value) };
}

describe('usePolling', () => {
  it('keeps the previous data while a new key loads when asked to', async () => {
    const { result, rerender, release } = renderPolling((key) => key === 'conn-1:1');
    await waitFor(() => expect(result.current.data).toBe('first'));

    rerender({ refetchKey: 'conn-1:2' });
    expect(result.current.data).toBe('first');

    release('second');
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('starts empty on a new key by default', async () => {
    const { result, rerender } = renderPolling();
    await waitFor(() => expect(result.current.data).toBe('first'));

    rerender({ refetchKey: 'conn-1:2' });
    expect(result.current.data).toBeNull();
  });
});
