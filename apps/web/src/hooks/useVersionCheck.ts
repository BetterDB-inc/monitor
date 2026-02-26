import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { versionApi } from '../api/version';
import type { VersionInfo } from '@betterdb/shared';

interface VersionCheckState extends VersionInfo {
  loading: boolean;
  error: Error | null;
  dismissed: boolean;
}

interface VersionCheckContextValue extends VersionCheckState {
  dismiss: () => void;
  refresh: () => Promise<void>;
}

const DEFAULT_STATE: VersionCheckState = {
  current: 'unknown',
  latest: null,
  updateAvailable: false,
  releaseUrl: null,
  checkedAt: null,
  loading: true,
  error: null,
  dismissed: false,
};

export const VersionCheckContext = createContext<VersionCheckContextValue>({
  ...DEFAULT_STATE,
  dismiss: () => {},
  refresh: async () => {},
});

const DISMISS_KEY = 'betterdb_update_dismissed_version';

export function useVersionCheckState(): VersionCheckContextValue {
  const [state, setState] = useState<VersionCheckState>(() => {
    // Check if user dismissed this version
    const dismissedVersion = localStorage.getItem(DISMISS_KEY);
    return {
      ...DEFAULT_STATE,
      dismissed: !!dismissedVersion,
    };
  });

  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const intervalMsRef = useRef(3600000);

  const fetchVersion = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const info = await versionApi.getVersion();

      if (info.versionCheckIntervalMs) {
        intervalMsRef.current = info.versionCheckIntervalMs;
      }

      // Check if this specific version was dismissed
      const dismissedVersion = localStorage.getItem(DISMISS_KEY);
      const isDismissed = dismissedVersion === info.latest;

      setState({
        ...info,
        loading: false,
        error: null,
        dismissed: isDismissed,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err : new Error('Failed to fetch version'),
      }));
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((prev) => {
      if (prev.latest) {
        localStorage.setItem(DISMISS_KEY, prev.latest);
      }
      return { ...prev, dismissed: true };
    });
  }, []);

  const refresh = useCallback(async () => {
    await fetchVersion();
  }, [fetchVersion]);

  useEffect(() => {
    fetchVersion().then(() => {
      intervalRef.current = setInterval(fetchVersion, intervalMsRef.current);
    });
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchVersion]);

  return {
    ...state,
    dismiss,
    refresh,
  };
}

export function useVersionCheck(): VersionCheckContextValue {
  return useContext(VersionCheckContext);
}
