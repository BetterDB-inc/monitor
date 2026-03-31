import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { agentTokensApi, type TokenListItem } from '../api/agent-tokens';

const QUERY_KEY = ['mcp-tokens'] as const;

export function useMcpTokens(enabled: boolean) {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<TokenListItem[], Error>({
    queryKey: QUERY_KEY,
    queryFn: () => agentTokensApi.list('mcp'),
    enabled,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }, [queryClient]);

  return {
    tokens: data ?? [],
    loading: isLoading,
    error: error ?? null,
    invalidate,
  };
}
