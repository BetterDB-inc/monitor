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

  const refresh = useCallback(async (): Promise<void> => {
    refreshSeq.current += 1;
    const seq = refreshSeq.current;
    try {
      const status = await workspaceApi.getStatus();
      if (seq !== refreshSeq.current) {
        return;
      }
      setAuthRedirectEnabled(status.mode === 'self-hosted' && status.enabled === true);
      setMode(status.mode);
      setBootstrapped(status.bootstrapped);
      if (status.enabled === false || status.bootstrapped === false) {
        setUnavailable(false);
        setUser(null);
        return;
      }
      try {
        const me = await workspaceApi.getMe();
        if (seq !== refreshSeq.current) {
          return;
        }
        setUnavailable(false);
        setUser(me);
      } catch (error) {
        if (seq !== refreshSeq.current) {
          return;
        }
        if (error instanceof UnauthorizedError) {
          setUnavailable(false);
          setUser(null);
          return;
        }
        if (status.mode === 'cloud') {
          setUnavailable(false);
          setUser(null);
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
      setUser(null);
    } finally {
      if (seq === refreshSeq.current) {
        setLoading(false);
      }
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    refreshSeq.current += 1;
    try {
      await workspaceApi.signOut();
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
