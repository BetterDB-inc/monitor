import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionNamespace } from '@betterdb/shared';
import { SessionExplorer } from './SessionExplorer';
import { sessionExplorerKeys } from '../hooks/useSessionExplorer';
import { detail, listResponse } from '../components/pages/session-explorer/__tests__/fixtures';

const { api, connection } = vi.hoisted(() => ({
  connection: { id: 'c1' },
  api: {
    listNamespaces: vi.fn(),
    deleteNamespace: vi.fn(),
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
