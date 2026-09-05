import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ReactElement, ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { UnauthorizedError } from '../api/client';
import { AuthProvider, useAuth } from './AuthContext';
import { AuthGate } from '../components/auth/AuthGate';

const getStatus = vi.fn();
const getMe = vi.fn();

const { setAuthRedirectEnabledMock } = vi.hoisted(() => {
  return { setAuthRedirectEnabledMock: vi.fn() };
});

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    setAuthRedirectEnabled: (enabled: boolean): void => {
      setAuthRedirectEnabledMock(enabled);
    },
  };
});

vi.mock('../api/workspace', () => ({
  workspaceApi: {
    getStatus: () => getStatus(),
    getMe: () => getMe(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function gateWrapperFor(path: string) {
  return function GateWrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AuthGate>
            <div>APP</div>
          </AuthGate>
          {children}
        </AuthProvider>
      </MemoryRouter>
    );
  };
}

describe('AuthGate routing', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getMe.mockReset();
  });

  it('renders the app when the workspace is disabled', async () => {
    getStatus.mockResolvedValue({ mode: 'disabled', enabled: false, bootstrapped: false });
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
    expect(getMe).not.toHaveBeenCalled();
  });

  it('renders register when not bootstrapped', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: false });
    renderAt('/connections');
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /create the owner account/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('renders login when bootstrapped and signed out', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new UnauthorizedError());
    renderAt('/connections');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument(),
    );
  });

  it('renders the app when signed in', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue({
      userId: 'u1',
      email: 'o@example.com',
      name: 'O',
      role: 'admin',
      isOwner: true,
    });
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
  });

  it('renders the app for cloud with the cloud user', async () => {
    getStatus.mockResolvedValue({ mode: 'cloud', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'owner', tenantId: 't' });
    renderAt('/');
    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
  });

  it('renders the app for cloud even when getMe fails', async () => {
    getStatus.mockResolvedValue({ mode: 'cloud', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new Error('502'));
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('keeps the query string in the login redirect target', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new UnauthorizedError());
    const { result } = renderHook(() => useLocation(), {
      wrapper: gateWrapperFor('/latency?window=24h&range=1'),
    });
    await waitFor(() => expect(result.current.pathname).toBe('/login'));
    expect(result.current.search).toBe(
      `?next=${encodeURIComponent('/latency?window=24h&range=1')}`,
    );
  });

  it('offers a retry instead of the app when the status call fails', async () => {
    getStatus.mockRejectedValue(new Error('500'));
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('Cannot reach the server')).toBeInTheDocument());
    expect(screen.queryByText('APP')).not.toBeInTheDocument();
    expect(getMe).not.toHaveBeenCalled();

    getStatus.mockResolvedValue({ mode: 'disabled', enabled: false, bootstrapped: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});

describe('AuthProvider state', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getMe.mockReset();
  });

  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  }

  it('marks the workspace unavailable instead of disabled when the status call fails', async () => {
    getStatus.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.isCloud).toBe(false);
  });

  it('clears the unavailable flag once the status call succeeds again', async () => {
    getStatus.mockRejectedValueOnce(new Error('500'));
    getStatus.mockResolvedValue({ mode: 'disabled', enabled: false, bootstrapped: false });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    await result.current.refresh();
    await waitFor(() => expect(result.current.unavailable).toBe(false));
    expect(result.current.mode).toBe('disabled');
  });
});

describe('login redirect wiring', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getMe.mockReset();
    setAuthRedirectEnabledMock.mockReset();
  });

  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  }

  it('enables the login redirect for an enabled self-hosted workspace', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue({
      userId: 'u1',
      email: 'o@example.com',
      name: 'O',
      role: 'admin',
      isOwner: true,
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(setAuthRedirectEnabledMock).toHaveBeenCalledWith(true);
  });

  it('leaves the login redirect off in cloud mode', async () => {
    getStatus.mockResolvedValue({ mode: 'cloud', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue({ userId: 'u1', email: 'o@example.com', role: 'owner', tenantId: 't' });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(setAuthRedirectEnabledMock).toHaveBeenCalledWith(false);
    expect(setAuthRedirectEnabledMock).not.toHaveBeenCalledWith(true);
  });

  it('leaves the login redirect off when the status call fails', async () => {
    getStatus.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(setAuthRedirectEnabledMock).toHaveBeenCalledWith(false);
  });

  it('ignores a stale getStatus rejection that resolves after a newer refresh succeeded', async () => {
    let rejectFirstGetStatus: ((reason: unknown) => void) | null = null;
    const firstGetStatus = new Promise((_resolve, reject) => {
      rejectFirstGetStatus = reject;
    });
    firstGetStatus.catch(() => undefined);
    getStatus.mockImplementationOnce(() => firstGetStatus);
    getStatus.mockResolvedValueOnce({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue({
      userId: 'u1',
      email: 'o@example.com',
      name: 'O',
      role: 'admin',
      isOwner: true,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(rejectFirstGetStatus).not.toBeNull());

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(setAuthRedirectEnabledMock).toHaveBeenLastCalledWith(true);

    await act(async () => {
      (rejectFirstGetStatus as (reason: unknown) => void)(new Error('500'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(setAuthRedirectEnabledMock).toHaveBeenLastCalledWith(true);
  });
});

describe('sign-out versus an in-flight refresh', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getMe.mockReset();
    setAuthRedirectEnabledMock.mockReset();
  });

  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  }

  it('discards a refresh that resolves after sign-out', async () => {
    const signedIn = {
      userId: 'u1',
      email: 'o@example.com',
      name: 'O',
      role: 'admin',
      isOwner: true,
    };
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockResolvedValue(signedIn);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(signedIn));

    let releaseGetMe: (() => void) | null = null;
    getMe.mockImplementation(() => {
      return new Promise((resolve) => {
        releaseGetMe = () => {
          resolve(signedIn);
        };
      });
    });

    let pendingRefresh: Promise<void> = Promise.resolve();
    act(() => {
      pendingRefresh = result.current.refresh();
    });
    await waitFor(() => expect(releaseGetMe).not.toBeNull());

    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.user).toBeNull();

    await act(async () => {
      (releaseGetMe as unknown as () => void)();
      await pendingRefresh;
    });
    expect(result.current.user).toBeNull();
  });
});

describe('getMe failure handling', () => {
  beforeEach(() => {
    getStatus.mockReset();
    getMe.mockReset();
    setAuthRedirectEnabledMock.mockReset();
  });

  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <MemoryRouter>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    );
  }

  it('signs the visitor out on a 401', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new UnauthorizedError());
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    expect(result.current.unavailable).toBe(false);
  });

  it('keeps the session and reports the server unavailable on a 5xx', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new Error('502'));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.mode).toBe('self-hosted');
    expect(result.current.bootstrapped).toBe(true);
  });

  it('shows the unavailable screen instead of login when getMe fails with a 5xx', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new Error('502'));
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('Cannot reach the server')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });

  const signedIn = {
    userId: 'u1',
    email: 'o@example.com',
    name: 'O',
    role: 'admin',
    isOwner: true,
  };

  it('keeps a signed-in user rendered when a later getMe fails', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockResolvedValueOnce(signedIn);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(signedIn));

    getMe.mockRejectedValue(new Error('502'));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.unavailable).toBe(false);
    expect(result.current.user).toEqual(signedIn);
  });

  it('retries in the background until the server recovers', async () => {
    vi.useFakeTimers();
    try {
      getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
      getMe.mockRejectedValueOnce(new Error('502'));
      getMe.mockResolvedValue(signedIn);
      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.unavailable).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.unavailable).toBe(false);
      expect(result.current.user).toEqual(signedIn);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the cloud user lookup after a 5xx', async () => {
    vi.useFakeTimers();
    try {
      const cloudUser = { userId: 'u1', email: 'o@example.com', role: 'owner', tenantId: 't' };
      getStatus.mockResolvedValue({ mode: 'cloud', enabled: true, bootstrapped: true });
      getMe.mockRejectedValueOnce(new Error('502'));
      getMe.mockResolvedValue(cloudUser);
      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.user).toBeNull();
      expect(result.current.unavailable).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(result.current.user).toEqual(cloudUser);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the unavailable screen through a retry until getMe settles', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValueOnce(new Error('502'));
    renderAt('/connections');
    await waitFor(() => expect(screen.getByText('Cannot reach the server')).toBeInTheDocument());

    let resolveGetMe: ((value: unknown) => void) | null = null;
    getMe.mockImplementationOnce(() => {
      return new Promise((resolve) => {
        resolveGetMe = resolve;
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.getByText('Cannot reach the server')).toBeInTheDocument();

    await act(async () => {
      (resolveGetMe as unknown as (value: unknown) => void)({
        userId: 'u1',
        email: 'o@example.com',
        name: 'O',
        role: 'admin',
        isOwner: true,
      });
    });

    await waitFor(() => expect(screen.getByText('APP')).toBeInTheDocument());
  });
});
