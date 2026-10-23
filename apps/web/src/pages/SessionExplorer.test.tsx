import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionNamespace } from '@betterdb/shared';
import { SessionExplorer } from './SessionExplorer';
import { listResponse } from '../components/pages/session-explorer/__tests__/fixtures';

const { api } = vi.hoisted(() => ({
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
  useConnection: () => ({ currentConnection: { id: 'c1' } }),
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

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionExplorer />
    </QueryClientProvider>,
  );

describe('SessionExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
