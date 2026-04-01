import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHookWithQuery, waitFor } from '../test/test-utils';

vi.mock('../api/agent-tokens', () => ({
  agentTokensApi: {
    list: vi.fn(),
  },
}));

import { agentTokensApi } from '../api/agent-tokens';
import { useMcpTokens } from './useMcpTokens';

const mockList = vi.mocked(agentTokensApi.list);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useMcpTokens', () => {
  it('does not fetch when disabled', () => {
    const { result } = renderHookWithQuery(() => useMcpTokens(false));
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.tokens).toEqual([]);
  });

  it('fetches tokens when enabled', async () => {
    const mockTokens = [
      { id: '1', name: 'test-token', type: 'mcp', createdAt: '2024-01-01', lastUsed: null },
    ];
    mockList.mockResolvedValue(mockTokens);

    const { result } = renderHookWithQuery(() => useMcpTokens(true));

    await waitFor(() => {
      expect(result.current.tokens).toEqual(mockTokens);
    });

    expect(mockList).toHaveBeenCalledWith('mcp');
  });

  it('returns error on failure', async () => {
    mockList.mockRejectedValue(new Error('Unauthorized'));

    const { result } = renderHookWithQuery(() => useMcpTokens(true));

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(Error);
    });
  });
});
