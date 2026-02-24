import { fetchApi } from './client';

export interface CloudUser {
  userId: string;
  email: string;
  tenantId: string;
  subdomain: string;
  role: string;
}

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
  getMe: () => fetchApi<CloudUser>('/workspace/me'),
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
