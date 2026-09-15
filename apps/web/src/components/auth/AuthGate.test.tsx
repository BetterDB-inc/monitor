import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthGate } from './AuthGate';

const { authState } = vi.hoisted(() => {
  return {
    authState: {
      loading: false,
      unavailable: false,
      mode: 'self-hosted',
      bootstrapped: true,
      user: null as null | { userId: string },
      isCloud: false,
      brokerEnabled: false,
      refresh: vi.fn(),
      signOut: vi.fn(),
    },
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));
vi.mock('../../pages/AcceptInvite', () => ({
  AcceptInvite: () => <div>ACCEPT INVITE</div>,
}));
vi.mock('../../pages/Login', () => ({
  Login: () => <div>LOGIN</div>,
}));
vi.mock('../../pages/Register', async () => {
  const router = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    Register: () => <div>REGISTER {router.useLocation().search}</div>,
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <AuthGate>
              <div data-testid="app">APP</div>
            </AuthGate>
          }
        />
        <Route path="/latency" element={<div data-testid="latency">LATENCY</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthGate signed-in /login redirect', () => {
  it('honours a safe relative next target', () => {
    authState.user = { userId: 'u1' };
    renderAt('/login?next=%2Flatency');
    expect(screen.getByTestId('latency')).toBeInTheDocument();
  });

  it('falls back to / for a protocol-relative next target', () => {
    authState.user = { userId: 'u1' };
    renderAt('/login?next=%2F%2Fevil.com');
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });

  it('falls back to / when next is absent', () => {
    authState.user = { userId: 'u1' };
    renderAt('/login');
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });
});

describe('AuthGate', () => {
  afterEach(() => {
    authState.bootstrapped = true;
  });

  it('keeps a broker error when an empty workspace forwards login to register', () => {
    authState.bootstrapped = false;
    authState.user = null;
    render(
      <MemoryRouter initialEntries={['/login?error=expired&next=%2Fsettings']}>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('REGISTER ?error=expired')).toBeInTheDocument();
  });

  it('forwards to a bare register page when there is no broker error', () => {
    authState.bootstrapped = false;
    authState.user = null;
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('REGISTER')).toBeInTheDocument();
  });

  it('serves /invite/:token to signed-out visitors', () => {
    authState.user = null;
    render(
      <MemoryRouter initialEntries={['/invite/abc']}>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('ACCEPT INVITE')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN')).not.toBeInTheDocument();
  });

  it('still sends signed-out visitors elsewhere to login', () => {
    authState.user = null;
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });

  it('sends signed-in users from /invite/:token into the app', () => {
    authState.user = { userId: 'u1' };
    render(
      <MemoryRouter initialEntries={['/invite/abc']}>
        <AuthGate>
          <div>APP</div>
        </AuthGate>
      </MemoryRouter>,
    );
    expect(screen.getByText('APP')).toBeInTheDocument();
    expect(screen.queryByText('ACCEPT INVITE')).not.toBeInTheDocument();
  });
});
