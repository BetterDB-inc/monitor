import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { Feature, type ProposalStatus, type StoredCacheProposal } from '@betterdb/shared';
import {
  cacheProposalsApi,
  type ApprovalResultPayload,
  type EditAndApproveBody,
  type ListProposalsParams,
  type ProposalDetailPayload,
  type RejectResultPayload,
} from '../api/cacheProposals';
import { useConnection } from './useConnection';
import { useLicense } from './useLicense';

const PENDING_POLL_INTERVAL_MS = 15_000;
const HISTORY_STALE_MS = 30_000;

const queryKeys = {
  pending: (connectionId: string | null, params: ListProposalsParams) =>
    ['cache-proposals', 'pending', connectionId, params] as const,
  history: (connectionId: string | null, params: ListProposalsParams) =>
    ['cache-proposals', 'history', connectionId, params] as const,
  detail: (id: string) => ['cache-proposals', 'detail', id] as const,
};

export function usePendingProposals(params: ListProposalsParams = {}, enabled = true) {
  const { currentConnection } = useConnection();
  const connectionId = currentConnection?.id ?? null;
  return useQuery<StoredCacheProposal[]>({
    queryKey: queryKeys.pending(connectionId, params),
    queryFn: () => cacheProposalsApi.listPending(params),
    enabled: enabled && !!connectionId,
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

const STORAGE_KEY = 'cache-proposals.last-seen-at';

function readLastSeenAt(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastSeenAt(timestamp: number | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (timestamp === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, String(timestamp));
    }
  } catch {
    // ignore storage failures (Safari private mode, etc.)
  }
}

let lastSeenAtSnapshot: number | null = readLastSeenAt();
const lastSeenListeners = new Set<() => void>();

function subscribeLastSeen(listener: () => void): () => void {
  lastSeenListeners.add(listener);
  return () => {
    lastSeenListeners.delete(listener);
  };
}

function getLastSeenSnapshot(): number | null {
  return lastSeenAtSnapshot;
}

function setLastSeenAt(timestamp: number | null): void {
  const next =
    timestamp !== null && lastSeenAtSnapshot !== null
      ? Math.max(lastSeenAtSnapshot, timestamp)
      : timestamp;
  if (lastSeenAtSnapshot === next) {
    return;
  }
  lastSeenAtSnapshot = next;
  writeLastSeenAt(next);
  for (const listener of lastSeenListeners) {
    listener();
  }
}

interface UnreadIndicatorState {
  unreadCount: number;
  markAllRead: () => void;
}

export function useCacheProposalsUnread(): UnreadIndicatorState {
  const { hasFeature } = useLicense();
  const entitled = hasFeature(Feature.CACHE_INTELLIGENCE);
  const { data: pending } = usePendingProposals({}, entitled);
  const lastSeenAt = useSyncExternalStore(
    subscribeLastSeen,
    getLastSeenSnapshot,
    getLastSeenSnapshot,
  );

  const unreadCount = useMemo(() => {
    if (!pending || pending.length === 0) {
      return 0;
    }
    if (lastSeenAt === null) {
      return pending.length;
    }
    return pending.filter((p) => p.proposed_at > lastSeenAt).length;
  }, [pending, lastSeenAt]);

  const newestPendingAt =
    pending && pending.length > 0
      ? pending.reduce((max, p) => (p.proposed_at > max ? p.proposed_at : max), 0)
      : null;
  const markAllRead = useCallback(() => {
    if (newestPendingAt === null) {
      return;
    }
    setLastSeenAt(newestPendingAt);
  }, [newestPendingAt]);

  return { unreadCount, markAllRead };
}

export type { ProposalStatus };
