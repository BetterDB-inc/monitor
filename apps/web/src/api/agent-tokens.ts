import { fetchApi } from './client';
import type { AgentConnectionInfo } from '@betterdb/shared';

export type TokenType = 'agent' | 'mcp';

export interface GeneratedToken {
  token: string;
  id: string;
  name: string;
  type: TokenType;
  expiresAt: number;
}

export interface TokenListItem {
  id: string;
  name: string;
  type: TokenType;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export const agentTokensApi = {
  generate: (name: string, type: TokenType = 'agent') =>
    fetchApi<GeneratedToken>('/agent-tokens', {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    }),

  list: (type?: TokenType) =>
    fetchApi<TokenListItem[]>(`/agent-tokens${type ? `?type=${type}` : ''}`),

  revoke: (id: string) =>
    fetchApi<{ revoked: boolean }>(`/agent-tokens/${id}`, {
      method: 'DELETE',
    }),

  getConnections: () =>
    fetchApi<AgentConnectionInfo[]>('/agent-tokens/connections'),
};
