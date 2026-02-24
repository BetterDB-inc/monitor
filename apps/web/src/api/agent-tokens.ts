import { fetchApi } from './client';
import type { AgentConnectionInfo } from '@betterdb/shared';

export interface GeneratedToken {
  token: string;
  id: string;
  name: string;
  expiresAt: number;
}

export interface TokenListItem {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export const agentTokensApi = {
  generate: (name: string) =>
    fetchApi<GeneratedToken>('/agent-tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  list: () => fetchApi<TokenListItem[]>('/agent-tokens'),

  revoke: (id: string) =>
    fetchApi<{ revoked: boolean }>(`/agent-tokens/${id}`, {
      method: 'DELETE',
    }),

  getConnections: () =>
    fetchApi<AgentConnectionInfo[]>('/agent-tokens/connections'),
};
