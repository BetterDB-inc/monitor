import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
vi.mock('../../pages/Register', () => ({
  Register: () => <div>REGISTER</div>,
}));

describe('AuthGate', () => {
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
