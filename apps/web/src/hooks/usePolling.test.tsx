import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('./useUpgradePrompt', () => ({ useUpgradePrompt: () => ({ showUpgradePrompt: vi.fn() }) }));

import { usePolling } from './usePolling';

interface Props {
  refetchKey: string;
  keepPreviousDataFor?: string;
}

function renderPolling(initialProps: Props) {
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
    ({ refetchKey, keepPreviousDataFor }: Props) =>
      usePolling<string>({ fetcher, interval: () => false, refetchKey, keepPreviousDataFor }),
    { wrapper, initialProps },
  );
  return { ...hook, release: (value: string) => release(value) };
}

describe('usePolling', () => {
  it('keeps the previous data while a new key loads for the same connection', async () => {
    const { result, rerender, release } = renderPolling({
      refetchKey: 'conn-1:1',
      keepPreviousDataFor: 'conn-1',
    });
    await waitFor(() => expect(result.current.data).toBe('first'));

    rerender({ refetchKey: 'conn-1:2', keepPreviousDataFor: 'conn-1' });
    expect(result.current.data).toBe('first');

    release('second');
    await waitFor(() => expect(result.current.data).toBe('second'));
  });

  it('starts empty when the connection changes', async () => {
    const { result, rerender } = renderPolling({
      refetchKey: 'conn-1:1',
      keepPreviousDataFor: 'conn-1',
    });
    await waitFor(() => expect(result.current.data).toBe('first'));

    rerender({ refetchKey: 'conn-2:1', keepPreviousDataFor: 'conn-2' });
    expect(result.current.data).toBeNull();
  });

  it('starts empty on a new key by default', async () => {
    const { result, rerender } = renderPolling({ refetchKey: 'conn-1:1' });
    await waitFor(() => expect(result.current.data).toBe('first'));

    rerender({ refetchKey: 'conn-1:2' });
    expect(result.current.data).toBeNull();
  });
});
