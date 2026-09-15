import { Injectable, Logger } from '@nestjs/common';
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

export interface BrokerSignIn {
  resolved: ResolvedBrokerUser;
  session: Response;
}

export type SessionStarter = (member: MemberRecord) => Promise<Response>;

export class BrokerNotInvitedError extends Error {}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

@Injectable()
export class BrokerUserResolver {
  private readonly logger = new Logger(BrokerUserResolver.name);

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

  async signIn(
    identity: BrokerIdentity,
    inviteTokenHash: string | null,
    startSession: SessionStarter,
  ): Promise<BrokerSignIn> {
    const created = await this.bootstrapLock.run(async () => {
      const resolved = await this.resolveNow(identity, inviteTokenHash);
      if (resolved.entrance === 'login') {
        return { resolved, session: null };
      }
      return { resolved, session: await this.startOrRevert(resolved, startSession) };
    });
    if (created.session !== null) {
      return { resolved: created.resolved, session: created.session };
    }
    return { resolved: created.resolved, session: await startSession(created.resolved.member) };
  }

  private async startOrRevert(
    resolved: ResolvedBrokerUser,
    startSession: SessionStarter,
  ): Promise<Response> {
    let session: Response;
    try {
      session = await startSession(resolved.member);
    } catch (error) {
      await this.revertLogged(resolved);
      throw error;
    }
    if (session.ok === false) {
      await this.revertLogged(resolved);
    }
    return session;
  }

  private async revertLogged(resolved: ResolvedBrokerUser): Promise<void> {
    try {
      await this.revert(resolved);
    } catch (error) {
      this.logger.error(
        `Could not undo the broker ${resolved.entrance} of ${resolved.member.email} ` +
          'after the session failed to start',
        describeError(error),
      );
    }
  }

  private async revert(resolved: ResolvedBrokerUser): Promise<void> {
    if (resolved.entrance === 'register') {
      await this.members.discardBootstrapOwner(resolved.member.id);
      return;
    }
    const invitationId = resolved.invitationId;
    if (resolved.entrance !== 'invite' || invitationId === null) {
      return;
    }
    await this.members.remove(resolved.member.id);
    await this.releaseClaim(invitationId);
  }

  private async releaseClaim(invitationId: string): Promise<void> {
    let reason = 'it was no longer accepted';
    try {
      if ((await this.invitations.release(invitationId)) === true) {
        return;
      }
    } catch (error) {
      reason = describeError(error);
    }
    this.logger.error(
      `Could not release invitation ${invitationId} after a failed broker sign-in: ${reason}. ` +
        'An admin can revoke it from the invitations list and invite again.',
    );
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
      await this.releaseClaim(invitation.id);
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
