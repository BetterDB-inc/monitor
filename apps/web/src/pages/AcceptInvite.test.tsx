import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AcceptInvite } from './AcceptInvite';

const { getInvite, acceptInvite, refresh } = vi.hoisted(() => {
  return { getInvite: vi.fn(), acceptInvite: vi.fn(), refresh: vi.fn() };
});

vi.mock('../api/workspace', () => ({
  workspaceApi: {
    getInvite: (token: string) => getInvite(token),
    acceptInvite: (token: string, body: unknown) => acceptInvite(token, body),
  },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ refresh }),
}));

function renderAt(token: string): void {
  render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AcceptInvite', () => {
  beforeEach(() => {
    getInvite.mockReset();
    acceptInvite.mockReset();
    refresh.mockReset();
    refresh.mockResolvedValue(undefined);
  });

  it('creates the account for the invited email and lands on the app', async () => {
    getInvite.mockResolvedValue({ email: 'new@example.com', role: 'member', expired: false });
    acceptInvite.mockResolvedValue({});
    renderAt('tok-1');
    const email = await screen.findByLabelText('Email');
    expect(email).toHaveValue('new@example.com');
    expect(email).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByText('HOME')).toBeInTheDocument());
    expect(acceptInvite).toHaveBeenCalledWith('tok-1', {
      name: 'New Person',
      password: 'correct horse battery',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the expired notice', async () => {
    getInvite.mockResolvedValue({ email: 'late@example.com', role: 'member', expired: true });
    renderAt('tok-2');
    expect(await screen.findByText(/This invite has expired/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('shows the invalid notice when the token is unknown', async () => {
    getInvite.mockRejectedValue(new Error('Invitation not found'));
    renderAt('tok-3');
    expect(await screen.findByText(/This invite link is not valid/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
  });

  it('shows the API error when accepting fails', async () => {
    getInvite.mockResolvedValue({ email: 'x@example.com', role: 'member', expired: false });
    acceptInvite.mockRejectedValue(new Error('Invitation is accepted'));
    renderAt('tok-4');
    await screen.findByLabelText('Email');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Invitation is accepted')).toBeInTheDocument();
  });
});
