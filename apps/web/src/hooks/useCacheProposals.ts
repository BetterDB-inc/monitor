import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type { ProposalStatus, StoredCacheProposal } from '@betterdb/shared';
import {
  cacheProposalsApi,
  type ApprovalResultPayload,
  type EditAndApproveBody,
  type ListProposalsParams,
  type ProposalDetailPayload,
  type RejectResultPayload,
} from '../api/cacheProposals';
import { useConnection } from './useConnection';

const PENDING_POLL_INTERVAL_MS = 15_000;
const HISTORY_STALE_MS = 30_000;

const queryKeys = {
  pending: (connectionId: string | null, params: ListProposalsParams) =>
    ['cache-proposals', 'pending', connectionId, params] as const,
  history: (connectionId: string | null, params: ListProposalsParams) =>
    ['cache-proposals', 'history', connectionId, params] as const,
  detail: (id: string) => ['cache-proposals', 'detail', id] as const,
};

export function usePendingProposals(params: ListProposalsParams = {}) {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  return useQuery<StoredCacheProposal[]>({
    queryKey: queryKeys.pending(connectionId, params),
    queryFn: () => cacheProposalsApi.listPending(params),
    enabled: !!connectionId,
    refetchInterval: PENDING_POLL_INTERVAL_MS,
  });
}

export function useHistoryProposals(params: ListProposalsParams = {}) {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  return useQuery<StoredCacheProposal[]>({
    queryKey: queryKeys.history(connectionId, params),
    queryFn: () => cacheProposalsApi.listHistory(params),
    enabled: !!connectionId,
    staleTime: HISTORY_STALE_MS,
  });
}

export function useProposalDetail(id: string | null) {
  return useQuery<ProposalDetailPayload>({
    queryKey: queryKeys.detail(id ?? ''),
    queryFn: () => cacheProposalsApi.get(id as string),
    enabled: !!id,
  });
}

function useInvalidateProposals() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ['cache-proposals'], refetchType: 'active' });
}

export function useApproveProposal(): UseMutationResult<
  ApprovalResultPayload,
  Error,
  { id: string; actor?: string }
> {
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: ({ id, actor }) => cacheProposalsApi.approve(id, actor),
    onSettled: invalidate,
  });
}

export function useRejectProposal(): UseMutationResult<
  RejectResultPayload,
  Error,
  { id: string; reason: string | null; actor?: string }
> {
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: ({ id, reason, actor }) => cacheProposalsApi.reject(id, reason, actor),
    onSettled: invalidate,
  });
}

export function useEditAndApproveProposal(): UseMutationResult<
  ApprovalResultPayload,
  Error,
  { id: string; body: EditAndApproveBody }
> {
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: ({ id, body }) => cacheProposalsApi.editAndApprove(id, body),
    onSettled: invalidate,
  });
}

const STORAGE_KEY = 'cache-proposals.last-seen-id';

function readLastSeenId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastSeenId(id: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (id) {
      window.localStorage.setItem(STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage failures (Safari private mode, etc.)
  }
}

let lastSeenIdSnapshot: string | null = readLastSeenId();
const lastSeenListeners = new Set<() => void>();

function subscribeLastSeen(listener: () => void): () => void {
  lastSeenListeners.add(listener);
  return () => {
    lastSeenListeners.delete(listener);
  };
}

function getLastSeenSnapshot(): string | null {
  return lastSeenIdSnapshot;
}

function setLastSeenId(id: string | null): void {
  if (lastSeenIdSnapshot === id) {
    return;
  }
  lastSeenIdSnapshot = id;
  writeLastSeenId(id);
  for (const listener of lastSeenListeners) {
    listener();
  }
}

interface UnreadIndicatorState {
  unreadCount: number;
  markAllRead: () => void;
}

export function useCacheProposalsUnread(): UnreadIndicatorState {
  const { data: pending } = usePendingProposals();
  const lastSeenId = useSyncExternalStore(
    subscribeLastSeen,
    getLastSeenSnapshot,
    getLastSeenSnapshot,
  );

  const unreadCount = useMemo(() => {
    if (!pending || pending.length === 0) {
      return 0;
    }
    if (!lastSeenId) {
      return pending.length;
    }
    const idx = pending.findIndex((p) => p.id === lastSeenId);
    if (idx === -1) {
      return pending.length;
    }
    return idx;
  }, [pending, lastSeenId]);

  const newestPendingId = pending && pending.length > 0 ? pending[0].id : null;
  const markAllRead = useCallback(() => {
    if (!newestPendingId) {
      return;
    }
    setLastSeenId(newestPendingId);
  }, [newestPendingId]);

  return { unreadCount, markAllRead };
}

export type { ProposalStatus };
