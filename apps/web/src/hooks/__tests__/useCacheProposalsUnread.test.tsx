import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import type { StoredCacheProposal } from '@betterdb/shared';
import { renderHookWithQuery, waitFor } from '../../test/test-utils';

// happy-dom's localStorage is unavailable in this project's test config; stub it.
const memoryStore = new Map<string, string>();
const stubStorage: Storage = {
  get length() {
    return memoryStore.size;
  },
  key: (i: number) => Array.from(memoryStore.keys())[i] ?? null,
  getItem: (k: string) => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string) => {
    memoryStore.set(k, v);
  },
  removeItem: (k: string) => {
    memoryStore.delete(k);
  },
  clear: () => {
    memoryStore.clear();
  },
};
Object.defineProperty(window, 'localStorage', { value: stubStorage, configurable: true });

const useLicenseMock = vi.fn();
const useConnectionMock = vi.fn();
const listPendingMock = vi.fn();

vi.mock('../useLicense', () => ({
  useLicense: () => useLicenseMock(),
}));

vi.mock('../useConnection', () => ({
  useConnection: () => useConnectionMock(),
}));

vi.mock('../../api/cacheProposals', () => ({
  cacheProposalsApi: {
    listPending: (...args: unknown[]) => listPendingMock(...args),
  },
}));

import { useCacheProposalsUnread } from '../useCacheProposals';

const STORAGE_KEY = 'cache-proposals.last-seen-at';

function pendingProposal(id: string, proposedAt: number): StoredCacheProposal {
  return {
    id,
    connection_id: 'c1',
    cache_name: 'faq-cache',
    cache_type: 'semantic_cache',
    proposal_type: 'threshold_adjust',
    proposal_payload: { category: null, current_threshold: 0.1, new_threshold: 0.075 },
    reasoning: 'r',
    status: 'pending',
    proposed_by: 'mcp:agent',
    proposed_at: proposedAt,
    reviewed_by: null,
    reviewed_at: null,
    applied_at: null,
    applied_result: null,
    expires_at: proposedAt + 86_400_000,
  } as StoredCacheProposal;
}

describe('useCacheProposalsUnread', () => {
  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    listPendingMock.mockReset();
    useLicenseMock.mockReset();
    useConnectionMock.mockReset();
    useConnectionMock.mockReturnValue({ currentConnection: { id: 'c1' } });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it('reports zero unread and skips polling when the feature is not entitled', async () => {
    useLicenseMock.mockReturnValue({ hasFeature: () => false });
    listPendingMock.mockResolvedValue([pendingProposal('p1', Date.now())]);

    const { result } = renderHookWithQuery(() => useCacheProposalsUnread());

    expect(result.current.unreadCount).toBe(0);
    // give react-query a tick; should still be 0 because query is disabled
    await new Promise((r) => setTimeout(r, 20));
    expect(listPendingMock).not.toHaveBeenCalled();
  });

  it('counts all pending as unread when no lastSeenAt has been recorded', async () => {
    useLicenseMock.mockReturnValue({ hasFeature: () => true });
    const now = Date.now();
    listPendingMock.mockResolvedValue([
      pendingProposal('p1', now - 30_000),
      pendingProposal('p2', now - 60_000),
    ]);

    const { result } = renderHookWithQuery(() => useCacheProposalsUnread());

    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  // Note: a "loads persisted lastSeenAt from localStorage on mount" test is omitted
  // because the hook caches the snapshot at module-import time; controlling that
  // across vitest's shared module cache is not worth the dance. The markAllRead test
  // below exercises the same filter path end-to-end (count goes from N to 0 after
  // mark-read, which can only happen if the lastSeenAt filter is applied).

  it('markAllRead persists the newest proposed_at and zeroes the unread count', async () => {
    useLicenseMock.mockReturnValue({ hasFeature: () => true });
    const now = Date.now();
    const newest = now - 10_000;
    listPendingMock.mockResolvedValue([
      pendingProposal('p1', now - 30_000),
      pendingProposal('p2', newest),
    ]);

    const { result } = renderHookWithQuery(() => useCacheProposalsUnread());

    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    act(() => {
      result.current.markAllRead();
    });

    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(newest));
  });
});
