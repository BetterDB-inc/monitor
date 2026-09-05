import {
  createContext,
  ReactElement,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { WorkspaceMode } from '@betterdb/shared';
import { setAuthRedirectEnabled, UnauthorizedError } from '../api/client';
import { CurrentUser, workspaceApi } from '../api/workspace';

export interface AuthState {
  loading: boolean;
  unavailable: boolean;
  mode: WorkspaceMode;
  bootstrapped: boolean;
  user: CurrentUser | null;
  isCloud: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const noop = async (): Promise<void> => {
  return undefined;
};

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;

const AuthContext = createContext<AuthState>({
  loading: true,
  unavailable: false,
  mode: 'disabled',
  bootstrapped: false,
  user: null,
  isCloud: false,
  refresh: noop,
  signOut: noop,
});

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [mode, setMode] = useState<WorkspaceMode>('disabled');
  const [bootstrapped, setBootstrapped] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const refreshSeq = useRef(0);
  const currentUser = useRef<CurrentUser | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(RETRY_BASE_MS);
  const refreshRef = useRef<() => Promise<void>>(noop);

  const rememberUser = useCallback((next: CurrentUser | null): void => {
    currentUser.current = next;
    setUser(next);
  }, []);

  const cancelRetry = useCallback((): void => {
    if (retryTimer.current === null) {
      return;
    }
    clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const scheduleRetry = useCallback((): void => {
    if (retryTimer.current !== null) {
      return;
    }
    const delay = retryDelay.current;
    retryDelay.current = Math.min(delay * 2, RETRY_MAX_MS);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      void refreshRef.current();
    }, delay);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    refreshSeq.current += 1;
    const seq = refreshSeq.current;
    cancelRetry();
    try {
      const status = await workspaceApi.getStatus();
      if (seq !== refreshSeq.current) {
        return;
      }
      setAuthRedirectEnabled(status.mode === 'self-hosted' && status.enabled === true);
      setMode(status.mode);
      setBootstrapped(status.bootstrapped);
      if (status.enabled === false || status.bootstrapped === false) {
        retryDelay.current = RETRY_BASE_MS;
        setUnavailable(false);
        rememberUser(null);
        return;
      }
      try {
        const me = await workspaceApi.getMe();
        if (seq !== refreshSeq.current) {
          return;
        }
        retryDelay.current = RETRY_BASE_MS;
        setUnavailable(false);
        rememberUser(me);
      } catch (error) {
        if (seq !== refreshSeq.current) {
          return;
        }
        if (error instanceof UnauthorizedError) {
          retryDelay.current = RETRY_BASE_MS;
          setUnavailable(false);
          rememberUser(null);
          return;
        }
        scheduleRetry();
        if (status.mode === 'cloud' || currentUser.current !== null) {
          setUnavailable(false);
          return;
        }
        setUnavailable(true);
      }
    } catch {
      if (seq !== refreshSeq.current) {
        return;
      }
      setAuthRedirectEnabled(false);
      setUnavailable(true);
      scheduleRetry();
    } finally {
      if (seq === refreshSeq.current) {
        setLoading(false);
      }
    }
  }, [cancelRetry, rememberUser, scheduleRetry]);

  const signOut = useCallback(async (): Promise<void> => {
    refreshSeq.current += 1;
    cancelRetry();
    retryDelay.current = RETRY_BASE_MS;
    try {
      await workspaceApi.signOut();
    } finally {
      rememberUser(null);
    }
  }, [cancelRetry, rememberUser]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    refresh();
    return () => {
      cancelRetry();
    };
  }, [refresh, cancelRetry]);

  const value = useMemo<AuthState>(() => {
    return {
      loading,
      unavailable,
      mode,
      bootstrapped,
      user,
      isCloud: mode === 'cloud',
      refresh,
      signOut,
    };
  }, [loading, unavailable, mode, bootstrapped, user, refresh, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
