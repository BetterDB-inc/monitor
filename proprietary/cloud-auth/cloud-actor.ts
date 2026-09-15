import type { Actor } from '@betterdb/shared';

export interface CloudSessionPayload {
  userId: string;
  email: string;
  role: string;
  subdomain: string;
  tenantId?: string;
}

export function cloudActor(payload: CloudSessionPayload): Actor {
  const isOwner = payload.role === 'owner';
  const isAdmin = isOwner === true || payload.role === 'admin';
  return {
    userId: payload.userId,
    email: payload.email,
    role: isAdmin === true ? 'admin' : 'member',
    isOwner,
    via: 'session',
    tokenId: null,
  };
}
