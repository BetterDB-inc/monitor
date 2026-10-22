import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KvCacheEngine } from '@betterdb/shared';

const { access, updateEngine, deleteEngine, conn } = vi.hoisted(() => ({
  access: { canMutate: true, isDemo: false },
  conn: { id: 'c1' },
  updateEngine: vi.fn(),
  deleteEngine: vi.fn(),
}));

vi.mock('../../../../hooks/useCanMutate', () => ({ useCanMutate: () => access.canMutate }));
vi.mock('../../../../contexts/DemoContext', () => ({ useIsDemo: () => access.isDemo }));
vi.mock('../../../../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: conn.id } }),
}));

vi.mock('../../../../api/kv-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/kv-cache')>();
  return { ...actual, kvCacheApi: { ...actual.kvCacheApi, updateEngine, deleteEngine } };
});

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

function renderEngines(engines: KvCacheEngine[] = [engine]) {
  const client = new QueryClient();
  const page = () => (
    <QueryClientProvider client={client}>
      <KvCacheEngines engines={engines} />
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  return { client, rerender: () => rerender(page()) };
}

const invalidatedConnections = (client: QueryClient) =>
  vi.mocked(client.invalidateQueries).mock.calls.map(([filters]) => (filters?.queryKey as unknown[])[2]);

describe('KvCacheEngines', () => {
  beforeEach(() => {
    access.canMutate = true;
    access.isDemo = false;
    updateEngine.mockReset();
    deleteEngine.mockReset();
    conn.id = 'c1';
  });

  it('refreshes the connection a toggle started on after the selection changes', async () => {
    let finish: (value: unknown) => void = () => undefined;
    updateEngine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { client, rerender } = renderEngines();
    vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable vllm-1' }));
    await waitFor(() => expect(updateEngine).toHaveBeenCalled());
    conn.id = 'c2';
    rerender();
    await act(async () => {
      finish(engine);
    });
    await waitFor(() => expect(client.invalidateQueries).toHaveBeenCalled());
    expect(new Set(invalidatedConnections(client))).toEqual(new Set(['c1']));
  });

  it('refreshes the connection a delete started on after the selection changes', async () => {
    let finish: (value: unknown) => void = () => undefined;
    deleteEngine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { client, rerender } = renderEngines();
    vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteEngine).toHaveBeenCalledWith('e1'));
    conn.id = 'c2';
    rerender();
    await act(async () => {
      finish(undefined);
    });
    await waitFor(() => expect(client.invalidateQueries).toHaveBeenCalled());
    expect(new Set(invalidatedConnections(client))).toEqual(new Set(['c1']));
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

  it('hides mutating controls on the demo instance', () => {
    access.isDemo = true;
    renderEngines();
    expect(screen.queryByRole('button', { name: 'Link engine' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Enable vllm-1' })).toBeDisabled();
  });

  it('shows the scrape URL exactly as the server returned it, since the server masks it', () => {
    renderEngines([{ ...engine, scrapeUrl: 'http://user@vllm:8000/metrics' }]);
    expect(screen.getByText('http://user@vllm:8000/metrics')).toBeInTheDocument();
  });

  it('tells the user when enabling or disabling an engine fails', async () => {
    updateEngine.mockRejectedValue(new Error('boom'));
    renderEngines();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable vllm-1' }));
    expect(await screen.findByText(/Could not update vllm-1: boom/)).toBeInTheDocument();
  });

  it('keeps a delete blocked and the next dialog open when an earlier delete lands late', async () => {
    let finish: (value: unknown) => void = () => undefined;
    deleteEngine.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const second = { ...engine, id: 'e2', name: 'vllm-2' } as KvCacheEngine;
    renderEngines([engine, second]);
    const rowDeletes = () => screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(rowDeletes()[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteEngine).toHaveBeenCalledWith('e1'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(rowDeletes()[1]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/vllm-2/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await act(async () => {
      finish(undefined);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText(/vllm-2/)).toBeInTheDocument();
    expect(deleteEngine).toHaveBeenCalledTimes(1);
  });

  it('does not show an earlier engine delete failure in the next delete dialog', async () => {
    let fail: (error: Error) => void = () => undefined;
    deleteEngine.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const second = { ...engine, id: 'e2', name: 'vllm-2' } as KvCacheEngine;
    renderEngines([engine, second]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteEngine).toHaveBeenCalledWith('e1'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
    await screen.findByRole('dialog');
    await act(async () => {
      fail(new Error('boom'));
    });
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })).toBeEnabled(),
    );
    expect(screen.queryByText('boom')).toBeNull();
  });
});
