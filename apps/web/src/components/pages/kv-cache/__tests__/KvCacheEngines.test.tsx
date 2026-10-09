import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KvCacheEngine } from '@betterdb/shared';

const { access } = vi.hoisted(() => ({ access: { canMutate: true } }));

vi.mock('../../../../hooks/useCanMutate', () => ({ useCanMutate: () => access.canMutate }));
vi.mock('../../../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
}));

import { KvCacheEngines } from '../KvCacheEngines';

const engine = {
  id: 'e1',
  connectionId: 'c1',
  name: 'vllm-1',
  source: 'scrape',
  scrapeUrl: 'http://vllm:8000/metrics',
  otlpEngineId: null,
  enabled: true,
  lastSeenAt: null,
  lastError: null,
  createdAt: 1,
} as unknown as KvCacheEngine;

function renderEngines() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <KvCacheEngines engines={[engine]} />
    </QueryClientProvider>,
  );
}

describe('KvCacheEngines', () => {
  beforeEach(() => {
    access.canMutate = true;
  });

  it('shows link, toggle and delete controls to admins', () => {
    renderEngines();
    expect(screen.getByRole('button', { name: 'Link engine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable vllm-1' })).toBeEnabled();
  });

  it('hides mutating controls from members', () => {
    access.canMutate = false;
    renderEngines();
    expect(screen.queryByRole('button', { name: 'Link engine' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Enable vllm-1' })).toBeDisabled();
  });
});
