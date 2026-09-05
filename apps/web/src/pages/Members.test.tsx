import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Members } from './Members';

const { api, authState, refreshMock } = vi.hoisted(() => {
  return {
    api: {
      getMembers: vi.fn(),
      getInvitations: vi.fn(),
      getActivity: vi.fn(),
      invite: vi.fn(),
      revokeInvitation: vi.fn(),
      removeMember: vi.fn(),
      updateMemberRole: vi.fn(),
      transferOwnership: vi.fn(),
    },
    authState: {
      user: null as null | { userId: string; email: string; role: string; isOwner: boolean },
    },
    refreshMock: vi.fn(),
  };
});

vi.mock('../api/workspace', () => ({ workspaceApi: api }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, refresh: refreshMock }),
}));

const OWNER = {
  id: 'u1',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
  isOwner: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};
const MEMBER = {
  id: 'u2',
  email: 'member@example.com',
  name: 'Member',
  role: 'member',
  isOwner: false,
  createdAt: '2026-09-02T00:00:00.000Z',
};
const INVITATION = {
  id: 'i1',
  email: 'pending@example.com',
  role: 'member',
  status: 'pending',
  invitedBy: 'u1',
  createdAt: '2026-09-02T00:00:00.000Z',
  expiresAt: '2026-09-09T00:00:00.000Z',
};

describe('Members', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    refreshMock.mockReset();
    api.getMembers.mockResolvedValue([OWNER, MEMBER]);
    api.getInvitations.mockResolvedValue([INVITATION]);
    api.getActivity.mockResolvedValue({ items: [], nextCursor: null });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('lets the owner invite and shows the one-time link', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'admin', isOwner: true };
    api.invite.mockResolvedValue({
      ...INVITATION,
      id: 'i2',
      email: 'new@example.com',
      url: 'http://localhost/invite/tok',
    });
    render(<Members />);
    await screen.findByText('member@example.com');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByDisplayValue('http://localhost/invite/tok')).toBeInTheDocument();
    expect(api.invite).toHaveBeenCalledWith({ email: 'new@example.com', role: 'member' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost/invite/tok'),
    );
  });

  it('keeps the typed email when the invite fails', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'admin', isOwner: true };
    api.invite.mockRejectedValue(new Error('A pending invitation already exists for this email'));
    render(<Members />);
    await screen.findByText('member@example.com');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dupe@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(
      await screen.findByText('A pending invitation already exists for this email'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('dupe@example.com');
  });

  it('shows owner actions on other members only', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'admin', isOwner: true };
    api.updateMemberRole.mockResolvedValue({ ...MEMBER, role: 'admin' });
    render(<Members />);
    const row = (await screen.findByText('member@example.com')).closest(
      'tr',
    ) as HTMLTableRowElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(api.updateMemberRole).toHaveBeenCalledWith('u2', 'admin'));
    const ownerRow = screen.getByText('owner@example.com').closest('tr') as HTMLTableRowElement;
    expect(within(ownerRow).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('shows members the list only', async () => {
    authState.user = { userId: 'u2', email: MEMBER.email, role: 'member', isOwner: false };
    render(<Members />);
    await screen.findByText('owner@example.com');
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(api.getInvitations).not.toHaveBeenCalled();
  });

  it('refreshes the current user after transferring ownership', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'admin', isOwner: true };
    api.transferOwnership.mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<Members />);
    const row = (await screen.findByText('member@example.com')).closest(
      'tr',
    ) as HTMLTableRowElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Make owner' }));
    await waitFor(() => expect(api.transferOwnership).toHaveBeenCalledWith('u2'));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('falls back to a sent banner when the backend emails the invite (cloud)', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'owner', isOwner: false };
    api.invite.mockResolvedValue({ ...INVITATION, id: 'i3', email: 'cloud@example.com' });
    render(<Members />);
    await screen.findByText('member@example.com');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'cloud@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Invitation sent to cloud@example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/invite/)).toBeNull();
  });

  it('shows the Activity tab to admins and hides it from members', async () => {
    authState.user = { userId: 'u1', email: OWNER.email, role: 'admin', isOwner: true };
    const { unmount } = render(<Members />);
    expect(await screen.findByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Activity' }), { button: 0 });
    expect(await screen.findByLabelText('Actor')).toBeInTheDocument();
    unmount();

    authState.user = { userId: 'u2', email: MEMBER.email, role: 'member', isOwner: false };
    render(<Members />);
    expect(await screen.findByText(MEMBER.email)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Activity' })).toBeNull();
  });
});
