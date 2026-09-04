import type { WorkspaceMe, WorkspaceStatus } from '@betterdb/shared';
import { fetchApi } from './client';

export type CurrentUser = WorkspaceMe & { tenantId?: string; subdomain?: string };
export type CloudUser = Omit<CurrentUser, 'role'> & { role: string };

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isOwner: boolean;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

export type InviteCreated = Invitation & { url?: string };

export interface InvitePreview {
  email: string;
  role: string;
  expired: boolean;
}

export interface ActivityEntry {
  id: string;
  occurredAt: string;
  actor: { userId: string; email: string; via: string; tokenId: string | null };
  action: string;
  target: { type: string; id: string } | null;
  connectionId: string | null;
  statusCode: number;
  ip: string;
  details: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityEntry[];
  nextCursor: string | null;
}

export interface ActivityQuery {
  actor?: string;
  from?: string;
  to?: string;
  action?: string;
  cursor?: string;
}

function activityQueryString(params: ActivityQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0) {
      search.set(key, value);
    }
  }
  const encoded = search.toString();
  if (encoded.length === 0) {
    return '';
  }
  return `?${encoded}`;
}

export const workspaceApi = {
  getStatus: () => fetchApi<WorkspaceStatus>('/system/workspace', { skipAuthRedirect: true }),
  getMe: () => fetchApi<CurrentUser>('/workspace/me', { skipAuthRedirect: true }),
  signUp: (body: { email: string; password: string; name: string }) =>
    fetchApi<unknown>('/auth/sign-up/email', { method: 'POST', body: JSON.stringify(body) }),
  signIn: (body: { email: string; password: string }) =>
    fetchApi<unknown>('/auth/sign-in/email', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => fetchApi<unknown>('/auth/sign-out', { method: 'POST', body: '{}' }),
  getMembers: () => fetchApi<Member[]>('/workspace/members'),
  getInvitations: () => fetchApi<Invitation[]>('/workspace/invitations'),
  getActivity: (params: ActivityQuery) =>
    fetchApi<ActivityPage>(`/workspace/activity${activityQueryString(params)}`),
  invite: (data: { email: string; role: string }) =>
    fetchApi<InviteCreated>('/workspace/invite', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokeInvitation: (id: string) =>
    fetchApi<void>(`/workspace/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  removeMember: (userId: string) =>
    fetchApi<void>(`/workspace/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  updateMemberRole: (userId: string, role: string) =>
    fetchApi<Member>(`/workspace/members/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  transferOwnership: (userId: string) =>
    fetchApi<void>('/workspace/ownership/transfer', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  getInvite: (token: string) =>
    fetchApi<InvitePreview>(`/invite/${encodeURIComponent(token)}`, { skipAuthRedirect: true }),
  acceptInvite: (token: string, body: { name: string; password: string }) =>
    fetchApi<CurrentUser>(`/invite/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: JSON.stringify(body),
      skipAuthRedirect: true,
    }),
};
