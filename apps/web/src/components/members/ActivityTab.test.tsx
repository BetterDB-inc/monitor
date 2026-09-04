import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ActivityEntry } from '@/api/workspace';
import { ActivityTab } from './ActivityTab';

const { api } = vi.hoisted(() => {
  return { api: { getActivity: vi.fn() } };
});

vi.mock('@/api/workspace', () => ({ workspaceApi: api }));

const MEMBERS = [
  {
    id: 'u1',
    email: 'owner@example.com',
    name: 'Owner',
    role: 'admin',
    isOwner: true,
    createdAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: 'u2',
    email: 'member@example.com',
    name: 'Member',
    role: 'member',
    isOwner: false,
    createdAt: '2026-09-02T00:00:00.000Z',
  },
];

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'e1',
    occurredAt: '2026-09-04T10:00:00.000Z',
    actor: { userId: 'u1', email: 'owner@example.com', via: 'session', tokenId: null },
    action: 'member.invite',
    target: { type: 'invitation', id: 'i1' },
    connectionId: null,
    statusCode: 201,
    ip: '127.0.0.1',
    details: { method: 'POST', path: '/workspace/invite' },
    ...overrides,
  };
}

describe('ActivityTab', () => {
  beforeEach(() => {
    api.getActivity.mockReset();
  });

  it('renders the first page and loads more with the cursor', async () => {
    api.getActivity
      .mockResolvedValueOnce({ items: [entry()], nextCursor: 'c1' })
      .mockResolvedValueOnce({
        items: [entry({ id: 'e2', action: 'cli.command', target: null, statusCode: 200 })],
        nextCursor: null,
      });
    render(<ActivityTab members={MEMBERS} />);
    expect(await screen.findByText('member.invite')).toBeInTheDocument();
    expect(screen.getByText('invitation i1')).toBeInTheDocument();
    expect(api.getActivity).toHaveBeenCalledWith({});
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('cli.command')).toBeInTheDocument();
    expect(api.getActivity).toHaveBeenLastCalledWith({ cursor: 'c1' });
    expect(screen.getByText('member.invite')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('filters by actor and action', async () => {
    api.getActivity.mockResolvedValue({ items: [], nextCursor: null });
    render(<ActivityTab members={MEMBERS} />);
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'u2' } });
    await waitFor(() => {
      expect(api.getActivity).toHaveBeenLastCalledWith({ actor: 'u2' });
    });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'cli.command' } });
    fireEvent.submit(screen.getByLabelText('Action').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(api.getActivity).toHaveBeenLastCalledWith({ actor: 'u2', action: 'cli.command' });
    });
  });

  it('shows the error when loading fails', async () => {
    api.getActivity.mockRejectedValue(new Error('boom'));
    render(<ActivityTab members={MEMBERS} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
