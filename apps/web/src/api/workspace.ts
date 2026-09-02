import type { WorkspaceMe, WorkspaceStatus } from '@betterdb/shared';
import { fetchApi } from './client';

export type CurrentUser = Omit<WorkspaceMe, 'role'> & {
  role: string;
  tenantId?: string;
  subdomain?: string;
};
export type CloudUser = CurrentUser;

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
  invite: (data: { email: string; role: string }) =>
    fetchApi<Invitation>('/workspace/invite', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokeInvitation: (id: string) =>
    fetchApi<void>(`/workspace/invitations/${id}`, { method: 'DELETE' }),
  removeMember: (userId: string) =>
    fetchApi<void>(`/workspace/members/${userId}`, { method: 'DELETE' }),
};
