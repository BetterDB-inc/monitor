import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithQuery } from '../../../test/test-utils';
import { McpTokensPanel } from './McpTokensPanel';

const { api, authState } = vi.hoisted(() => {
  return {
    api: {
      generate: vi.fn(),
      list: vi.fn(),
      revoke: vi.fn(),
      getConnections: vi.fn(),
    },
    authState: {
      user: null as null | { userId: string; email: string; role: string; isOwner: boolean },
      isCloud: false,
    },
  };
});

vi.mock('../../../api/agent-tokens', () => ({ agentTokensApi: api }));
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, isCloud: authState.isCloud }),
}));

const DAY_MS = 86_400_000;
const OWN = {
  id: 't1',
  name: 'laptop',
  type: 'mcp',
  createdAt: Date.now() - DAY_MS,
  expiresAt: Date.now() + DAY_MS,
  revokedAt: null,
  lastUsedAt: null,
  userId: 'u2',
  ownerEmail: 'member@example.com',
};
const OTHER = { ...OWN, id: 't2', name: 'ci', userId: 'u1', ownerEmail: 'owner@example.com' };
const REMOVED_MEMBER = { ...OWN, id: 't5', name: 'orphaned', userId: 'u9', ownerEmail: null };
const OWNERLESS = { ...OWN, id: 't6', name: 'cloud-key', userId: null, ownerEmail: null };

describe('McpTokensPanel', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    authState.user = { userId: 'u2', email: 'member@example.com', role: 'member', isOwner: false };
    authState.isCloud = false;
  });

  it('lists tokens and names the owner of tokens that are not yours', async () => {
    authState.user = { userId: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true };
    api.list.mockResolvedValue([OWN, OTHER]);
    renderWithQuery(<McpTokensPanel />);
    expect(await screen.findByText('laptop')).toBeInTheDocument();
    expect(screen.getByText('ci')).toBeInTheDocument();
    expect(screen.getByText('Owner: member@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Owner: owner@example.com')).not.toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith('mcp');
  });

  it("labels a removed member's token instead of hiding it", async () => {
    authState.user = { userId: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true };
    api.list.mockResolvedValue([REMOVED_MEMBER]);
    renderWithQuery(<McpTokensPanel />);
    expect(await screen.findByText('Owner: removed member')).toBeInTheDocument();
  });

  it('labels an ownerless token as owned by no one, not the viewing admin', async () => {
    authState.user = { userId: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true };
    api.list.mockResolvedValue([OWNERLESS]);
    renderWithQuery(<McpTokensPanel />);
    expect(await screen.findByText('Owner: none')).toBeInTheDocument();
  });

  it('generates a token, shows it once with the client config, and refreshes the list', async () => {
    api.list.mockResolvedValue([]);
    api.generate.mockResolvedValue({
      token: 'bdb_mcp_secret',
      id: 't3',
      name: 'laptop',
      type: 'mcp',
      expiresAt: Date.now() + DAY_MS,
    });
    renderWithQuery(<McpTokensPanel />);
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });
    fireEvent.change(screen.getByPlaceholderText('Token name (e.g., claude-code)'), {
      target: { value: '  laptop  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => {
      expect(api.generate).toHaveBeenCalledWith('laptop', 'mcp');
    });
    expect(await screen.findByLabelText('MCP token')).toHaveValue('bdb_mcp_secret');
    expect(screen.getByText(/"BETTERDB_TOKEN": "bdb_mcp_secret"/)).toBeInTheDocument();
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  it('generates only one token when Enter is pressed again while generating', async () => {
    api.list.mockResolvedValue([]);
    let resolveGenerate: (value: unknown) => void = () => {};
    api.generate.mockReturnValue(
      new Promise((resolve) => {
        resolveGenerate = resolve;
      }),
    );
    renderWithQuery(<McpTokensPanel />);
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });
    const input = screen.getByPlaceholderText('Token name (e.g., claude-code)');
    fireEvent.change(input, { target: { value: 'laptop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toBeDisabled();
    resolveGenerate({
      token: 'bdb_mcp_secret',
      id: 't3',
      name: 'laptop',
      type: 'mcp',
      expiresAt: Date.now() + DAY_MS,
    });
    expect(await screen.findByLabelText('MCP token')).toHaveValue('bdb_mcp_secret');
    expect(api.generate).toHaveBeenCalledTimes(1);
  });

  it('revokes a token and shows server errors', async () => {
    api.list.mockResolvedValue([OWN]);
    api.revoke.mockRejectedValue(new Error('Token not found'));
    renderWithQuery(<McpTokensPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(api.revoke).toHaveBeenCalledWith('t1');
    });
    expect(await screen.findByText('Token not found')).toBeInTheDocument();
  });

  it('marks revoked and expired tokens without a revoke button', async () => {
    api.list.mockResolvedValue([
      { ...OWN, id: 'r', name: 'revoked-one', revokedAt: Date.now() },
      { ...OWN, id: 'e', name: 'expired-one', expiresAt: 1 },
    ]);
    renderWithQuery(<McpTokensPanel />);
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  async function showGeneratedToken(): Promise<void> {
    api.list.mockResolvedValue([]);
    api.generate.mockResolvedValue({
      token: 'bdb_mcp_secret',
      id: 't3',
      name: 'laptop',
      type: 'mcp',
      expiresAt: Date.now() + DAY_MS,
    });
    renderWithQuery(<McpTokensPanel />);
    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });
    fireEvent.change(screen.getByPlaceholderText('Token name (e.g., claude-code)'), {
      target: { value: 'laptop' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByLabelText('MCP token')).toHaveValue('bdb_mcp_secret');
  }

  it('shows Copied when the clipboard write succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await showGeneratedToken();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('bdb_mcp_secret');
  });

  it('keeps the token selectable when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await showGeneratedToken();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Copy failed. Select the token and copy it manually.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('MCP token')).toHaveValue('bdb_mcp_secret');
    expect(screen.queryByRole('button', { name: 'Copied!' })).not.toBeInTheDocument();
  });

  it('keeps the token selectable when the clipboard write is rejected', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    await showGeneratedToken();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Copy failed. Select the token and copy it manually.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('MCP token')).toHaveValue('bdb_mcp_secret');
    expect(screen.queryByRole('button', { name: 'Copied!' })).not.toBeInTheDocument();
  });

  it('tells self-hosted users that a token acts as them', async () => {
    api.list.mockResolvedValue([]);
    renderWithQuery(<McpTokensPanel />);
    expect(await screen.findByText(/acts as you/)).toBeInTheDocument();
  });

  describe('generated client config origin', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
      vi.unstubAllEnvs();
    });

    it('points BETTERDB_URL at the API port in dev, not the Vite origin', async () => {
      vi.stubEnv('PROD', false);
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, origin: 'http://localhost:5173' },
      });
      await showGeneratedToken();
      expect(screen.getByText(/"BETTERDB_URL": "http:\/\/localhost:3001"/)).toBeInTheDocument();
    });

    it('points BETTERDB_URL at the browser origin in production', async () => {
      vi.stubEnv('PROD', true);
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, origin: 'https://monitor.example.com' },
      });
      await showGeneratedToken();
      expect(
        screen.getByText(/"BETTERDB_URL": "https:\/\/monitor\.example\.com"/),
      ).toBeInTheDocument();
    });
  });
});
