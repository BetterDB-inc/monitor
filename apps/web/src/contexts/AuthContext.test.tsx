import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './AuthContext';
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
});
