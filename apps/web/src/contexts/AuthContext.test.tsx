import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ReactElement, ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { AuthGate } from '../components/auth/AuthGate';

const getStatus = vi.fn();
const getMe = vi.fn();

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
  });

  it('renders login when bootstrapped and signed out', async () => {
    getStatus.mockResolvedValue({ mode: 'self-hosted', enabled: true, bootstrapped: true });
    getMe.mockRejectedValue(new Error('401'));
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
    getMe.mockRejectedValue(new Error('401'));
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
