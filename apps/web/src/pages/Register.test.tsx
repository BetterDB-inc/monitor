import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Register } from './Register';

vi.mock('../api/workspace', () => ({
  workspaceApi: { signUp: vi.fn() },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ refresh: vi.fn().mockResolvedValue(undefined), brokerEnabled: false }),
}));

describe('Register', () => {
  it('shows the broker error that was forwarded from the login redirect', () => {
    render(
      <MemoryRouter initialEntries={['/register?error=expired']}>
        <Register />
      </MemoryRouter>,
    );
    expect(screen.getByText('That sign-in link expired. Try again.')).toBeInTheDocument();
  });

  it('shows no notice without a broker error', () => {
    render(
      <MemoryRouter initialEntries={['/register']}>
        <Register />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
  });
});
