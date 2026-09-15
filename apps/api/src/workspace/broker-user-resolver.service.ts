import { Injectable } from '@nestjs/common';
import type { BrokerProvider } from '@betterdb/shared';
import { BootstrapLock } from '../auth/bootstrap-lock';
import { InvitationService } from './invitation.service';
import { MemberRecord, MemberService } from './member.service';

export type BrokerEntrance = 'login' | 'register' | 'invite';

export interface BrokerIdentity {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  provider: BrokerProvider;
  providerId: string;
}

export interface ResolvedBrokerUser {
  member: MemberRecord;
  entrance: BrokerEntrance;
  invitationId: string | null;
}

export class BrokerNotInvitedError extends Error {}

@Injectable()
export class BrokerUserResolver {
  constructor(
    private readonly members: MemberService,
    private readonly invitations: InvitationService,
    private readonly bootstrapLock: BootstrapLock,
  ) {}

  resolve(identity: BrokerIdentity, inviteTokenHash: string | null): Promise<ResolvedBrokerUser> {
    return this.bootstrapLock.run(() => {
      return this.resolveNow(identity, inviteTokenHash);
    });
  }

  async revert(resolved: ResolvedBrokerUser): Promise<void> {
    if (resolved.entrance === 'register') {
      await this.members.discardBootstrapOwner(resolved.member.id);
      return;
    }
    const invitationId = resolved.invitationId;
    if (resolved.entrance !== 'invite' || invitationId === null) {
      return;
    }
    try {
      await this.members.remove(resolved.member.id);
    } finally {
      await this.invitations.release(invitationId);
    }
  }

  private async resolveNow(
    identity: BrokerIdentity,
    inviteTokenHash: string | null,
  ): Promise<ResolvedBrokerUser> {
    const existing = await this.members.findByEmail(identity.email);
    if (existing !== null) {
      await this.members.ensureProviderLink(existing.id, identity.provider, identity.providerId);
      return { member: existing, entrance: 'login', invitationId: null };
    }
    if ((await this.members.count()) === 0) {
      const owner = await this.createMember(identity, 'admin', true);
      return { member: owner, entrance: 'register', invitationId: null };
    }
    const invitation = await this.invitations.claimForEmail(identity.email, inviteTokenHash);
    if (invitation === null) {
      throw new BrokerNotInvitedError('No pending invitation for this email');
    }
    try {
      const member = await this.createMember(identity, invitation.role, false);
      return { member, entrance: 'invite', invitationId: invitation.id };
    } catch (error) {
      await this.invitations.release(invitation.id);
      throw error;
    }
  }

  private createMember(
    identity: BrokerIdentity,
    role: MemberRecord['role'],
    isOwner: boolean,
  ): Promise<MemberRecord> {
    return this.members.createSocial({
      email: identity.email,
      name: identity.name,
      image: identity.avatarUrl,
      role,
      isOwner,
      provider: identity.provider,
      providerAccountId: identity.providerId,
    });
  }
}
