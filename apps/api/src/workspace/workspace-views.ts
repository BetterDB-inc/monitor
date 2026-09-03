import type { WorkspaceRole } from '@betterdb/shared';
import type {
  InvitationRecord,
  InvitationStatus,
} from '../common/interfaces/invitation-repository.interface';
import type { MemberRecord } from './member.service';

export interface MemberView {
  id: string;
  email: string;
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
}

export function toMemberView(member: MemberRecord): MemberView {
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.role,
    isOwner: member.isOwner,
    createdAt: new Date(member.createdAt).toISOString(),
  };
}

export function toInvitationView(invitation: InvitationRecord): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    createdAt: new Date(invitation.createdAt).toISOString(),
    expiresAt: new Date(invitation.expiresAt).toISOString(),
  };
}
