import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, type RenderOptions, type RenderHookOptions } from '@testing-library/react';
import type { ReactNode } from 'react';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

export function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderWithQuery(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const queryClient = createTestQueryClient();
  return {
    ...render(ui, { wrapper: createWrapper(queryClient), ...options }),
    queryClient,
  };
}

export function renderHookWithQuery<T>(
  hook: () => T,
  options?: Omit<RenderHookOptions<T>, 'wrapper'>,
) {
  const queryClient = createTestQueryClient();
  return {
    ...renderHook(hook, { wrapper: createWrapper(queryClient), ...options }),
    queryClient,
  };
}

export { waitFor, screen, act } from '@testing-library/react';
