import {
  createContext,
  ReactElement,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { WorkspaceMode } from '@betterdb/shared';
import { setAuthRedirectEnabled } from '../api/client';
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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const status = await workspaceApi.getStatus();
      setAuthRedirectEnabled(status.mode === 'self-hosted' && status.enabled === true);
      setUnavailable(false);
      setMode(status.mode);
      setBootstrapped(status.bootstrapped);
      if (status.enabled === false || status.bootstrapped === false) {
        setUser(null);
        return;
      }
      try {
        setUser(await workspaceApi.getMe());
      } catch {
        setUser(null);
      }
    } catch {
      setAuthRedirectEnabled(false);
      setUnavailable(true);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
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
