import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { WorkspaceRole } from '@betterdb/shared';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../auth/workspace-config';
import type {
  InvitationRecord,
  InvitationRepository,
} from '../common/interfaces/invitation-repository.interface';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { MemberService } from './member.service';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ALREADY_MEMBER_MESSAGE = 'User is already a member of this workspace';
export const PENDING_EXISTS_MESSAGE = 'A pending invitation already exists for this email';
export const INVITATION_NOT_FOUND_MESSAGE = 'Invitation not found';
export const INVITATION_EXPIRED_MESSAGE = 'Invitation has expired';
export const EMAIL_REQUIRED_MESSAGE = 'Email is required';

const TOKEN_BYTES = 32;

export type Clock = () => number;

export interface CreateInvitationInput {
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
}

export interface CreatedInvitation {
  invitation: InvitationRecord;
  token: string;
}

export interface InvitationPreview {
  email: string;
  role: WorkspaceRole;
  expired: boolean;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function trimTrailingSlash(value: string): string {
  if (value.endsWith('/') === true) {
    return value.slice(0, -1);
  }
  return value;
}

@Injectable()
export class InvitationService {
  private readonly repository: InvitationRepository;
  private readonly now: Clock;

  constructor(
    @Inject('STORAGE_CLIENT') storage: StoragePort,
    private readonly members: MemberService,
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Optional() @Inject('INVITATION_CLOCK') clock: Clock | null = null,
  ) {
    this.repository = storage.getInvitationRepository();
    this.now = clock ?? Date.now;
  }

  async create(input: CreateInvitationInput): Promise<CreatedInvitation> {
    const email = normalizeEmail(input.email);
    if (email.length === 0) {
      throw new BadRequestException(EMAIL_REQUIRED_MESSAGE);
    }
    const member = await this.members.findByEmail(email);
    if (member !== null) {
      throw new ConflictException(ALREADY_MEMBER_MESSAGE);
    }
    const existing = await this.repository.findByEmail(email);
    const now = this.now();
    if (existing !== null && existing.status === 'pending' && existing.expiresAt > now) {
      throw new ConflictException(PENDING_EXISTS_MESSAGE);
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitation: InvitationRecord = {
      id: randomUUID(),
      email,
      role: input.role,
      tokenHash: hashInvitationToken(token),
      invitedBy: input.invitedBy,
      status: 'pending',
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
    };
    await this.repository.save(invitation);
    return { invitation, token };
  }

  list(): Promise<InvitationRecord[]> {
    return this.repository.list();
  }

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findPending(token);
    return {
      email: invitation.email,
      role: invitation.role,
      expired: invitation.expiresAt <= this.now(),
    };
  }

  async claim(token: string): Promise<InvitationRecord> {
    const invitation = await this.findPending(token);
    if (invitation.expiresAt <= this.now()) {
      throw new BadRequestException(INVITATION_EXPIRED_MESSAGE);
    }
    const claimed = await this.repository.updateStatus(invitation.id, 'pending', 'accepted');
    if (claimed === false) {
      throw new BadRequestException('Invitation is accepted');
    }
    return { ...invitation, status: 'accepted' };
  }

  async release(id: string): Promise<void> {
    await this.repository.updateStatus(id, 'accepted', 'pending');
  }

  async revoke(id: string): Promise<void> {
    const invitation = await this.repository.findById(id);
    if (invitation === null) {
      throw new NotFoundException(INVITATION_NOT_FOUND_MESSAGE);
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Cannot revoke invitation with status ${invitation.status}`);
    }
    const revoked = await this.repository.updateStatus(id, 'pending', 'revoked');
    if (revoked === false) {
      throw new BadRequestException('Cannot revoke invitation with status accepted');
    }
  }

  inviteUrl(token: string, requestOrigin: string | null): string {
    const path = `/invite/${token}`;
    if (this.config.publicUrl !== null) {
      return `${trimTrailingSlash(this.config.publicUrl)}${path}`;
    }
    if (requestOrigin !== null) {
      return `${trimTrailingSlash(requestOrigin)}${path}`;
    }
    return path;
  }

  private async findPending(token: string): Promise<InvitationRecord> {
    const invitation = await this.repository.findByTokenHash(hashInvitationToken(token));
    if (invitation === null) {
      throw new NotFoundException(INVITATION_NOT_FOUND_MESSAGE);
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException(`Invitation is ${invitation.status}`);
    }
    return invitation;
  }
}
