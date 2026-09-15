import type { WorkspaceRole } from '@betterdb/shared';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export interface InvitationRecord {
  id: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  invitedBy: string;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
}

export interface InvitationRepository {
  findById(id: string): Promise<InvitationRecord | null>;
  findByEmail(email: string): Promise<InvitationRecord | null>;
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  list(): Promise<InvitationRecord[]>;
  save(record: InvitationRecord): Promise<void>;
  saveUnlessPending(record: InvitationRecord, now: number): Promise<boolean>;
  updateStatus(id: string, from: InvitationStatus, to: InvitationStatus): Promise<boolean>;
}
