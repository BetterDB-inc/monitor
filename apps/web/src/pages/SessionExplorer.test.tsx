import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionNamespace } from '@betterdb/shared';
import { SessionExplorer } from './SessionExplorer';
import { sessionExplorerKeys } from '../hooks/useSessionExplorer';
import { detail, listResponse } from '../components/pages/session-explorer/__tests__/fixtures';

const { api, connection, demo } = vi.hoisted(() => ({
  connection: { id: 'c1' },
  demo: { on: false },
  api: {
    listNamespaces: vi.fn(),
    deleteNamespace: vi.fn(),
    createNamespace: vi.fn(),
    updateNamespace: vi.fn(),
    listSessions: vi.fn(),
    oversize: vi.fn(),
    getSession: vi.fn(),
    exportSession: vi.fn(),
  },
}));

vi.mock('../api/session-explorer', () => ({ sessionExplorerApi: api }));

vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: { id: connection.id } }),
}));

vi.mock('../contexts/DemoContext', () => ({
  useIsDemo: () => demo.on,
}));

vi.mock('../hooks/useLicense', () => ({
  useLicense: () => ({ hasFeature: () => false }),
}));

const ns = (id: string): SessionNamespace => ({
  id,
  connectionId: 'c1',
  name: `ns-${id}`,
  pattern: `${id}:*`,
  preset: 'langchain-community',
  customSchema: null,
  oversizeThresholdBytes: 1024,
  createdAt: 1,
  updatedAt: 1,
});

const media = (matching: string[]) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: matching.includes(query), media: query })),
  );

const spyScroll = () =>
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = () => (
    <QueryClientProvider client={client}>
      <SessionExplorer />
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  return { client, rerender: () => rerender(page()) };
};

describe('SessionExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connection.id = 'c1';
    vi.stubGlobal('confirm', vi.fn(() => true));
    api.listSessions.mockResolvedValue(listResponse());
    api.deleteNamespace.mockResolvedValue(undefined);
    demo.on = false;
    media([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('activates the next namespace after deleting the first one', async () => {
    api.listNamespaces
      .mockResolvedValueOnce([ns('a'), ns('b')])
      .mockReturnValue(new Promise<SessionNamespace[]>(() => {}));
    renderPage();

    const select = (await screen.findByLabelText('Namespace')) as HTMLSelectElement;
    expect(select.value).toBe('a');
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith('a', expect.anything()));
    api.listSessions.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.deleteNamespace).toHaveBeenCalledWith('a'));
    await waitFor(() =>
      expect((screen.getByLabelText('Namespace') as HTMLSelectElement).value).toBe('b'),
    );
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith('b', expect.anything()));
    expect(api.listSessions.mock.calls.map(([id]) => id)).not.toContain('a');
    expect(screen.queryByRole('option', { name: 'ns-a' })).toBeNull();
  });

  const saveSetup = () => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chats' } });
    fireEvent.change(screen.getByLabelText('Key pattern'), { target: { value: 'b:*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  };

  it('does not rescan the previous namespace when a new one is created', async () => {
    api.listNamespaces.mockResolvedValueOnce([ns('a')]).mockResolvedValue([ns('a'), ns('b')]);
    api.createNamespace.mockResolvedValue(ns('b'));
    renderPage();

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith('a', expect.anything()));
    api.listSessions.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    saveSetup();

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith('b', expect.anything()));
    expect(api.listSessions.mock.calls.map(([id]) => id)).not.toContain('a');
  });

  it('rescans a namespace after it is edited', async () => {
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.updateNamespace.mockResolvedValue({ ...ns('a'), pattern: 'b:*' });
    renderPage();

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    saveSetup();

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
  });

  it('keeps the page when a namespace refetch fails after a successful load', async () => {
    api.listNamespaces
      .mockResolvedValueOnce([ns('a'), ns('b')])
      .mockRejectedValue(new Error('namespaces unavailable'));
    const { client } = renderPage();

    await screen.findByLabelText('Namespace');
    await act(() =>
      client
        .invalidateQueries({ queryKey: sessionExplorerKeys.namespaces('c1'), exact: true })
        .catch(() => undefined),
    );

    await screen.findByText('namespaces unavailable');
    expect((screen.getByLabelText('Namespace') as HTMLSelectElement).value).toBe('a');
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('shows the error view when the first namespace load fails', async () => {
    api.listNamespaces.mockRejectedValue(new Error('namespaces unavailable'));
    renderPage();

    await screen.findByText('namespaces unavailable');
    expect(screen.queryByLabelText('Namespace')).toBeNull();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('brings the session detail into view once it has rendered', async () => {
    const scrollIntoView = spyScroll();
    let resolve: (value: ReturnType<typeof detail>) => void = () => {};
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();

    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(api.getSession).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => resolve(detail({ sessionId: 'alpha', estimatedTokens: 77 })));

    const region = screen.getByRole('region', { name: 'Session detail' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.contexts[0]).toBe(region);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(within(region).getByText(/~77 tokens/)).toBeInTheDocument();
    expect(document.activeElement).toBe(region);
  });

  it('brings the detail back into view when the open session is clicked again', async () => {
    const scrollIntoView = spyScroll();
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockResolvedValue(detail({ sessionId: 'alpha' }));
    renderPage();

    const row = (await screen.findByText('alpha')).closest('tr')!;
    fireEvent.click(row);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    row.focus();
    fireEvent.click(row);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Session detail' }));
  });

  it('does not scroll when the detail sits beside the list', async () => {
    media(['(min-width: 1536px)']);
    const scrollIntoView = spyScroll();
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockResolvedValue(detail({ sessionId: 'alpha', estimatedTokens: 77 }));
    renderPage();

    const row = (await screen.findByText('alpha')).closest('tr')!;
    row.focus();
    fireEvent.click(row);

    await screen.findByText(/~77 tokens/);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
  });

  it('scrolls without animation when reduced motion is preferred', async () => {
    media(['(prefers-reduced-motion: reduce)']);
    const scrollIntoView = spyScroll();
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockResolvedValue(detail({ sessionId: 'alpha' }));
    renderPage();

    fireEvent.click(await screen.findByText('alpha'));

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }),
    );
  });

  it('opens another session at the top of the detail panel', async () => {
    media(['(min-width: 1536px)']);
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockImplementation((_ns: string, id: string) =>
      Promise.resolve(detail({ sessionId: id, estimatedTokens: id === 'alpha' ? 1 : 2 })),
    );
    renderPage();

    fireEvent.click(await screen.findByText('alpha'));
    await screen.findByText(/~1 tokens/);
    const region = screen.getByRole('region', { name: 'Session detail' });
    region.scrollTop = 400;

    fireEvent.click(screen.getByText('bravo'));
    await screen.findByText(/~2 tokens/);

    expect(region.scrollTop).toBe(0);
  });

  it('keeps the stuck detail below the demo banner', async () => {
    demo.on = true;
    api.listNamespaces.mockResolvedValue([ns('a')]);
    renderPage();

    await screen.findByText('alpha');
    const region = screen.getByRole('region', { name: 'Session detail' });
    expect(region).toHaveClass('2xl:top-[3.25rem]');
    expect(region).not.toHaveClass('2xl:top-4');
  });

  it('rereads the list and the open session when Refresh is pressed', async () => {
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockResolvedValue(detail({ sessionId: 'alpha' }));
    renderPage();

    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(1));
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2));
  });

  it('clears the session filter when switching to a cached namespace', async () => {
    api.listNamespaces.mockResolvedValue([ns('a'), ns('b')]);
    const { client } = renderPage();
    client.setQueryData(
      sessionExplorerKeys.sessions('c1', 'b'),
      listResponse({
        sessions: [
          { sessionId: 'delta', keyCount: 1, memoryBytes: 1, unmeasuredKeys: 0, idleSeconds: 1, ttlMs: null },
        ],
      }),
    );

    await screen.findByText('alpha');
    fireEvent.click(screen.getByRole('button', { name: /Size/ }));
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'alpha' } });
    expect(screen.queryByText('bravo')).toBeNull();

    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'b' } });

    await screen.findByText('delta');
    expect((screen.getByLabelText('Filter sessions') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /Size/ }).closest('th')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('does not request the previous session after switching connections', async () => {
    api.listNamespaces.mockResolvedValue([ns('a')]);
    api.getSession.mockReturnValue(new Promise(() => {}));
    const { client, rerender } = renderPage();
    client.setQueryData(sessionExplorerKeys.namespaces('c2'), [ns('b')]);

    fireEvent.click(await screen.findByText('alpha'));
    await waitFor(() => expect(api.getSession).toHaveBeenCalledWith('a', 'alpha', expect.anything()));
    api.getSession.mockClear();

    connection.id = 'c2';
    rerender();

    await waitFor(() =>
      expect((screen.getByLabelText('Namespace') as HTMLSelectElement).value).toBe('b'),
    );
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith('b', expect.anything()));
    expect(api.getSession).not.toHaveBeenCalled();
  });
});
