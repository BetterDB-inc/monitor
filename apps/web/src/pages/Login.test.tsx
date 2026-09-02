import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Login } from './Login';

const signIn = vi.fn();
vi.mock('../api/workspace', () => ({
  workspaceApi: { signIn: (body: unknown) => signIn(body) },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ refresh: vi.fn().mockResolvedValue(undefined) }),
}));

describe('Login', () => {
  it('signs in and navigates to next', async () => {
    signIn.mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={['/login?next=%2Fsettings']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/settings" element={<div>SETTINGS</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'o@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'correct horse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('SETTINGS')).toBeInTheDocument());
    expect(signIn).toHaveBeenCalledWith({ email: 'o@example.com', password: 'correct horse' });
  });

  it('shows the API error on failure', async () => {
    signIn.mockRejectedValue(new Error('Invalid email or password'));
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Login />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'o@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'nope nope nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeInTheDocument());
  });
});
