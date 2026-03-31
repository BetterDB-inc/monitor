import { useState, useCallback, createContext, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { versionApi } from '../api/version';
import type { VersionInfo } from '@betterdb/shared';

interface VersionCheckContextValue extends VersionInfo {
  loading: boolean;
  error: Error | null;
  dismissed: boolean;
  dismiss: () => void;
  refresh: () => Promise<void>;
}

const DEFAULT_STATE: VersionCheckContextValue = {
  current: 'unknown',
  latest: null,
  updateAvailable: false,
  releaseUrl: null,
  checkedAt: null,
  loading: true,
  error: null,
  dismissed: false,
  dismiss: () => {},
  refresh: async () => {},
};

export const VersionCheckContext = createContext<VersionCheckContextValue>(DEFAULT_STATE);

const DISMISS_KEY = 'betterdb_update_dismissed_version';

export function useVersionCheckState(): VersionCheckContextValue {
  const queryClient = useQueryClient();
  const [dismissedVersion, setDismissedVersion] = useState(
    () => localStorage.getItem(DISMISS_KEY),
  );

  const { data, isLoading, error } = useQuery<VersionInfo, Error>({
    queryKey: ['version-check'],
    queryFn: () => versionApi.getVersion(),
    refetchInterval: (query) => {
      const intervalMs = (query.state.data as VersionInfo & { versionCheckIntervalMs?: number })
        ?.versionCheckIntervalMs;
      return intervalMs ?? 3600000;
    },
  });

  const dismiss = useCallback(() => {
    if (data?.latest) {
      localStorage.setItem(DISMISS_KEY, data.latest);
      setDismissedVersion(data.latest);
    }
  }, [data?.latest]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['version-check'] });
  }, [queryClient]);

  return {
    current: data?.current ?? 'unknown',
    latest: data?.latest ?? null,
    updateAvailable: data?.updateAvailable ?? false,
    releaseUrl: data?.releaseUrl ?? null,
    checkedAt: data?.checkedAt ?? null,
    loading: isLoading,
    error: error ?? null,
    dismissed: dismissedVersion !== null && dismissedVersion === data?.latest,
    dismiss,
    refresh,
  };
}

export function useVersionCheck(): VersionCheckContextValue {
  return useContext(VersionCheckContext);
}
