import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderWithQuery } from '../test/test-utils';
import { AccountMcpTokens } from './AccountMcpTokens';
import { SidebarUserMenu } from '../components/layout/SidebarUserMenu';
import { RestrictedRoute } from '../components/layout/RestrictedRoute';

const { api, authState } = vi.hoisted(() => {
  return {
    api: {
      generate: vi.fn(),
      list: vi.fn(),
      revoke: vi.fn(),
    },
    authState: {
      user: null as null | { userId: string; email: string; role: string; isOwner: boolean },
      mode: 'self-hosted' as 'self-hosted' | 'cloud' | 'disabled',
      isCloud: false,
      signOut: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const useCanMutateMock = vi.fn();
const useDemoStateMock = vi.fn();

vi.mock('../api/agent-tokens', () => ({ agentTokensApi: api }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    mode: authState.mode,
    isCloud: authState.isCloud,
    signOut: authState.signOut,
  }),
}));
vi.mock('../hooks/useCanMutate', () => ({ useCanMutate: () => useCanMutateMock() }));
vi.mock('../contexts/DemoContext', () => ({ useDemoState: () => useDemoStateMock() }));

function renderApp(initialPath: string) {
  return renderWithQuery(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarUserMenu />
      <Routes>
        <Route path="/" element={<div>Home page</div>} />
        <Route path="/account/mcp-tokens" element={<AccountMcpTokens />} />
        <Route
          path="/settings"
          element={
            <RestrictedRoute>
              <div>Settings page</div>
            </RestrictedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('member reachability for personal MCP tokens', () => {
  it('lets a self-hosted member navigate from the user menu to the token page', async () => {
    api.list.mockReset();
    api.list.mockResolvedValue([]);
    authState.user = { userId: 'u2', email: 'member@example.com', role: 'member', isOwner: false };
    authState.mode = 'self-hosted';
    authState.isCloud = false;
    useCanMutateMock.mockReset();
    useCanMutateMock.mockReturnValue(false);
    useDemoStateMock.mockReset();
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: false });

    renderApp('/');
    fireEvent.click(screen.getByRole('link', { name: 'MCP Tokens' }));

    expect(
      await screen.findByPlaceholderText('Token name (e.g., claude-code)'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'MCP Tokens' })).toBeInTheDocument();
  });

  it('still redirects a member away from /settings', () => {
    api.list.mockReset();
    api.list.mockResolvedValue([]);
    authState.user = { userId: 'u2', email: 'member@example.com', role: 'member', isOwner: false };
    authState.mode = 'self-hosted';
    authState.isCloud = false;
    useCanMutateMock.mockReset();
    useCanMutateMock.mockReturnValue(false);
    useDemoStateMock.mockReset();
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: false });

    renderApp('/settings');

    expect(screen.getByText('Home page')).toBeInTheDocument();
    expect(screen.queryByText('Settings page')).not.toBeInTheDocument();
  });

  it('lets a self-hosted admin reach the token page too', async () => {
    api.list.mockReset();
    api.list.mockResolvedValue([]);
    authState.user = { userId: 'u1', email: 'admin@example.com', role: 'admin', isOwner: true };
    authState.mode = 'self-hosted';
    authState.isCloud = false;
    useCanMutateMock.mockReset();
    useCanMutateMock.mockReturnValue(true);
    useDemoStateMock.mockReset();
    useDemoStateMock.mockReturnValue({ isDemo: false, loading: false });

    renderApp('/account/mcp-tokens');

    expect(
      await screen.findByPlaceholderText('Token name (e.g., claude-code)'),
    ).toBeInTheDocument();
  });
});
