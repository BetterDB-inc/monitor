import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { renderWithQuery } from '../test/test-utils';
import { Settings } from './Settings';

const { tokensApi, workspaceApi, settingsApi, authState } = vi.hoisted(() => {
  return {
    tokensApi: {
      generate: vi.fn(),
      list: vi.fn(),
      revoke: vi.fn(),
    },
    workspaceApi: {
      getMembers: vi.fn(),
      getInvitations: vi.fn(),
    },
    settingsApi: {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      resetSettings: vi.fn(),
    },
    authState: {
      user: null as null | { userId: string; email: string; role: string; isOwner: boolean },
      mode: 'self-hosted' as 'self-hosted' | 'cloud' | 'disabled',
      isCloud: false,
    },
  };
});

const useCanMutateMock = vi.fn();
const useDemoStateMock = vi.fn();

vi.mock('../api/agent-tokens', () => ({ agentTokensApi: tokensApi }));
vi.mock('../api/workspace', () => ({ workspaceApi }));
vi.mock('../api/settings', () => ({ settingsApi }));
vi.mock('../api/license', () => ({ licenseApi: {} }));
vi.mock('../hooks/useLicense', () => ({
  useLicense: () => ({ tier: 'community', license: null }),
}));
vi.mock('../hooks/useConnection', () => ({
  useConnection: () => ({ currentConnection: null }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    mode: authState.mode,
    isCloud: authState.isCloud,
    refresh: vi.fn(),
  }),
}));
vi.mock('../hooks/useCanMutate', () => ({ useCanMutate: () => useCanMutateMock() }));
vi.mock('../contexts/DemoContext', () => ({ useDemoState: () => useDemoStateMock() }));

const MEMBER = { userId: 'u2', email: 'member@example.com', role: 'member', isOwner: false };
const ADMIN = { userId: 'u1', email: 'admin@example.com', role: 'admin', isOwner: true };

function renderApp(initialPath: string) {
  return renderWithQuery(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div>Home page</div>} />
        <Route
          path="/workspace/members"
          element={<Navigate to="/settings?section=team" replace />}
        />
        <Route
          path="/account/mcp-tokens"
          element={<Navigate to="/settings?section=mcp-tokens" replace />}
        />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </MemoryRouter>,
  );
}

function signIn(user: typeof MEMBER, canMutate: boolean, isDemo = false): void {
  authState.user = user;
  authState.mode = 'self-hosted';
  authState.isCloud = false;
  useCanMutateMock.mockReturnValue(canMutate);
  useDemoStateMock.mockReturnValue({ isDemo, loading: false });
}

describe('Settings access', () => {
  beforeEach(() => {
    for (const api of [tokensApi, workspaceApi, settingsApi]) {
      for (const fn of Object.values(api)) {
        fn.mockReset();
      }
    }
    useCanMutateMock.mockReset();
    useDemoStateMock.mockReset();
    tokensApi.list.mockResolvedValue([]);
    workspaceApi.getMembers.mockResolvedValue([]);
    workspaceApi.getInvitations.mockResolvedValue([]);
    settingsApi.getSettings.mockResolvedValue({
      settings: { id: 1, localRetentionDays: null },
      source: 'database',
      requiresRestart: false,
    });
  });

  it('opens on the Team section for a member and locks the admin sections', async () => {
    signIn(MEMBER, false);

    renderApp('/settings');

    expect(await screen.findByRole('heading', { level: 2, name: 'Team' })).toBeInTheDocument();
    expect(screen.getByText('License').closest('[aria-disabled="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'License' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
    expect(settingsApi.getSettings).not.toHaveBeenCalled();
  });

  it('lets a member switch to their MCP tokens', async () => {
    signIn(MEMBER, false);

    renderApp('/settings');
    fireEvent.click(screen.getByRole('button', { name: 'MCP Tokens' }));

    expect(
      await screen.findByPlaceholderText('Token name (e.g., claude-code)'),
    ).toBeInTheDocument();
  });

  it('ignores a request for an admin section from a member', async () => {
    signIn(MEMBER, false);

    renderApp('/settings?section=license');

    expect(await screen.findByRole('heading', { level: 2, name: 'Team' })).toBeInTheDocument();
  });

  it('redirects the old MCP tokens page to its Settings section', async () => {
    signIn(MEMBER, false);

    renderApp('/account/mcp-tokens');

    expect(
      await screen.findByPlaceholderText('Token name (e.g., claude-code)'),
    ).toBeInTheDocument();
  });

  it('redirects the old Team page to its Settings section', async () => {
    signIn(ADMIN, true);

    renderApp('/workspace/members');

    expect(await screen.findByRole('heading', { level: 2, name: 'Team' })).toBeInTheDocument();
  });

  it('keeps demo visitors out of Settings', () => {
    signIn(ADMIN, true, true);

    renderApp('/settings?section=mcp-tokens');

    expect(screen.getByText('Home page')).toBeInTheDocument();
  });

  it('loads the admin settings and unlocks every section for an admin', async () => {
    signIn(ADMIN, true);

    renderApp('/settings');

    expect(await screen.findByText('Source: database')).toBeInTheDocument();
    expect(settingsApi.getSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'License' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Team' })).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceApi.getMembers).toHaveBeenCalled();
    });
  });
});
