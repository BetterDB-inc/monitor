import { Injectable } from '@nestjs/common';
import type { BrokerProvider } from '@betterdb/shared';
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
}

export class BrokerNotInvitedError extends Error {}

@Injectable()
export class BrokerUserResolver {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly members: MemberService,
    private readonly invitations: InvitationService,
  ) {}

  resolve(identity: BrokerIdentity, inviteTokenHash: string | null): Promise<ResolvedBrokerUser> {
    const pending = this.queue.then(() => {
      return this.resolveNow(identity, inviteTokenHash);
    });
    this.queue = pending.then(
      () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
    return pending;
  }

  private async resolveNow(
    identity: BrokerIdentity,
    inviteTokenHash: string | null,
  ): Promise<ResolvedBrokerUser> {
    const existing = await this.members.findByEmail(identity.email);
    if (existing !== null) {
      await this.members.ensureProviderLink(existing.id, identity.provider, identity.providerId);
      return { member: existing, entrance: 'login' };
    }
    if ((await this.members.count()) === 0) {
      const owner = await this.createMember(identity, 'admin', true);
      return { member: owner, entrance: 'register' };
    }
    const invitation = await this.invitations.claimForEmail(identity.email, inviteTokenHash);
    if (invitation === null) {
      throw new BrokerNotInvitedError('No pending invitation for this email');
    }
    try {
      const member = await this.createMember(identity, invitation.role, false);
      return { member, entrance: 'invite' };
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
