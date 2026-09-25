import type { WorkspaceRole } from '@betterdb/shared';
import type {
  InvitationRecord,
  InvitationStatus,
} from '../common/interfaces/invitation-repository.interface';
import type { MemberRecord } from './member.service';

export interface MemberView {
  id: string;
  email?: string;
  name: string | null;
  role: WorkspaceRole;
  isOwner: boolean;
  createdAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  orphaned: boolean;
}

export function toMemberView(member: MemberRecord, includeEmail = true): MemberView {
  return {
    id: member.id,
    ...(includeEmail === true ? { email: member.email } : {}),
    name: member.name,
    role: member.role,
    isOwner: member.isOwner,
    createdAt: new Date(member.createdAt).toISOString(),
  };
}

export function toInvitationView(
  invitation: InvitationRecord,
  memberEmails: ReadonlySet<string> = new Set(),
): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    createdAt: new Date(invitation.createdAt).toISOString(),
    expiresAt: new Date(invitation.expiresAt).toISOString(),
    orphaned: invitation.status === 'accepted' && memberEmails.has(invitation.email) === false,
  };
}
