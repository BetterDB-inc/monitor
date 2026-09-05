import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createBetterAuth } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import type { InvitationRepository } from '../common/interfaces/invitation-repository.interface';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { InvitationMemoryRepository } from '../storage/adapters/repositories/invitation.memory.repository';
import {
  ALREADY_MEMBER_MESSAGE,
  hashInvitationToken,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_TTL_MS,
  InvitationService,
  PENDING_EXISTS_MESSAGE,
} from './invitation.service';
import { MemberService } from './member.service';

describe('InvitationService', () => {
  let repository: InvitationRepository;
  let members: MemberService;
  let service: InvitationService;
  const now = 1_700_000_000_000;

  function build(publicUrl: string | undefined): InvitationService {
    const config = resolveWorkspaceConfig(
      publicUrl === undefined ? {} : { AUTH_PUBLIC_URL: publicUrl },
    );
    const storage = { getInvitationRepository: () => repository } as unknown as StoragePort;
    return new InvitationService(storage, members, config, () => {
      return now;
    });
  }

  beforeEach(async () => {
    repository = new InvitationMemoryRepository();
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    members = new MemberService(auth);
    service = build('https://monitor.example.com');
  });

  it('creates a pending invitation with a lowercase email, hashed token and 7-day expiry', async () => {
    const { invitation, token } = await service.create({
      email: '  New.Person@Example.com ',
      role: 'member',
      invitedBy: 'owner-id',
    });
    expect(invitation).toEqual({
      id: expect.any(String),
      email: 'new.person@example.com',
      role: 'member',
      tokenHash: hashInvitationToken(token),
      invitedBy: 'owner-id',
      status: 'pending',
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.tokenHash).not.toContain(token);
    expect(await repository.findByEmail('new.person@example.com')).toEqual(invitation);
  });

  it('rejects an empty email', async () => {
    await expect(
      service.create({ email: '   ', role: 'member', invitedBy: 'owner-id' }),
    ).rejects.toThrow(new BadRequestException('Email is required'));
  });

  it('rejects an email that already belongs to a member', async () => {
    await members.create({
      email: 'taken@example.com',
      name: 'Taken',
      password: 'correct horse battery',
      role: 'member',
    });
    await expect(
      service.create({ email: 'Taken@example.com', role: 'member', invitedBy: 'owner-id' }),
    ).rejects.toThrow(new ConflictException(ALREADY_MEMBER_MESSAGE));
  });

  it('rejects a second pending invitation for the same email', async () => {
    await service.create({ email: 'dup@example.com', role: 'member', invitedBy: 'owner-id' });
    await expect(
      service.create({ email: 'dup@example.com', role: 'admin', invitedBy: 'owner-id' }),
    ).rejects.toThrow(new ConflictException(PENDING_EXISTS_MESSAGE));
  });

  it('re-issues an invitation whose previous one was revoked, accepted or expired', async () => {
    const first = await service.create({
      email: 'again@example.com',
      role: 'member',
      invitedBy: 'owner-id',
    });
    await service.revoke(first.invitation.id);
    const second = await service.create({
      email: 'again@example.com',
      role: 'admin',
      invitedBy: 'owner-id',
    });
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect(second.invitation.status).toBe('pending');
    expect(second.invitation.role).toBe('admin');
    expect(await repository.list()).toEqual([second.invitation]);

    const expired = build('https://monitor.example.com');
    await repository.save({ ...second.invitation, expiresAt: now - 1 });
    const third = await expired.create({
      email: 'again@example.com',
      role: 'member',
      invitedBy: 'owner-id',
    });
    expect(third.invitation.id).not.toBe(second.invitation.id);
  });

  it('lists invitations newest first', async () => {
    await service.create({ email: 'x@example.com', role: 'member', invitedBy: 'owner-id' });
    const later = new InvitationService(
      { getInvitationRepository: () => repository } as unknown as StoragePort,
      members,
      resolveWorkspaceConfig({}),
      () => {
        return now + 10;
      },
    );
    await later.create({ email: 'y@example.com', role: 'member', invitedBy: 'owner-id' });
    const emails = (await service.list()).map((item) => {
      return item.email;
    });
    expect(emails).toEqual(['y@example.com', 'x@example.com']);
  });

  it('previews a pending invitation by token and reports expiry', async () => {
    const { token } = await service.create({
      email: 'p@example.com',
      role: 'admin',
      invitedBy: 'owner-id',
    });
    expect(await service.preview(token)).toEqual({
      email: 'p@example.com',
      role: 'admin',
      expired: false,
    });
    const later = build(undefined);
    await repository.save({
      ...(await repository.findByEmail('p@example.com'))!,
      expiresAt: now - 1,
    });
    expect(await later.preview(token)).toEqual({
      email: 'p@example.com',
      role: 'admin',
      expired: true,
    });
    await expect(service.preview('unknown')).rejects.toThrow(
      new NotFoundException(INVITATION_NOT_FOUND_MESSAGE),
    );
  });

  it('claims a pending invitation exactly once and can release it', async () => {
    const { invitation, token } = await service.create({
      email: 'c@example.com',
      role: 'member',
      invitedBy: 'owner-id',
    });
    expect(await service.claim(token)).toEqual({ ...invitation, status: 'accepted' });
    await expect(service.claim(token)).rejects.toThrow(
      new BadRequestException('Invitation is accepted'),
    );
    await service.release(invitation.id);
    expect((await repository.findById(invitation.id))?.status).toBe('pending');
    expect(await service.claim(token)).toEqual({ ...invitation, status: 'accepted' });
  });

  it('refuses to claim an unknown, expired or revoked invitation', async () => {
    await expect(service.claim('unknown')).rejects.toThrow(
      new NotFoundException(INVITATION_NOT_FOUND_MESSAGE),
    );
    const { invitation, token } = await service.create({
      email: 'e@example.com',
      role: 'member',
      invitedBy: 'owner-id',
    });
    await repository.save({ ...invitation, expiresAt: now });
    await expect(service.claim(token)).rejects.toThrow(
      new BadRequestException(INVITATION_EXPIRED_MESSAGE),
    );
    await repository.save({ ...invitation, status: 'revoked' });
    await expect(service.claim(token)).rejects.toThrow(
      new BadRequestException('Invitation is revoked'),
    );
  });

  it('revokes only pending invitations', async () => {
    const { invitation } = await service.create({
      email: 'r@example.com',
      role: 'member',
      invitedBy: 'owner-id',
    });
    await service.revoke(invitation.id);
    expect((await repository.findById(invitation.id))?.status).toBe('revoked');
    await expect(service.revoke(invitation.id)).rejects.toThrow(
      new BadRequestException('Cannot revoke invitation with status revoked'),
    );
    await expect(service.revoke('unknown')).rejects.toThrow(
      new NotFoundException(INVITATION_NOT_FOUND_MESSAGE),
    );
  });

  it('builds the invite link from the public URL, else from the request origin', () => {
    expect(service.inviteUrl('tok', 'http://request.local')).toBe(
      'https://monitor.example.com/invite/tok',
    );
    expect(build('https://monitor.example.com/').inviteUrl('tok', null)).toBe(
      'https://monitor.example.com/invite/tok',
    );
    expect(build(undefined).inviteUrl('tok', 'http://request.local')).toBe(
      'http://request.local/invite/tok',
    );
    expect(build(undefined).inviteUrl('tok', null)).toBe('/invite/tok');
  });
});
