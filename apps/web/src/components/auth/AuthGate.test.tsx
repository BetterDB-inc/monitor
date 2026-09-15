import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthGate } from './AuthGate';

const authState = {
  loading: false,
  unavailable: false,
  mode: 'self-hosted' as const,
  bootstrapped: true,
  user: { userId: 'u1', email: 'o@example.com', name: 'O', role: 'admin', isOwner: true } as {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    isOwner: boolean;
  } | null,
  refresh: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

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
    renderAt('/login?next=%2Flatency');
    expect(screen.getByTestId('latency')).toBeInTheDocument();
  });

  it('falls back to / for a protocol-relative next target', () => {
    renderAt('/login?next=%2F%2Fevil.com');
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });

  it('falls back to / when next is absent', () => {
    renderAt('/login');
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });
});
