import { NotFoundException } from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
import { createBetterAuth } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { MemberRecord, MemberService } from './member.service';
import {
  hashPersonalToken,
  PERSONAL_TOKEN_PREFIX,
  PERSONAL_TOKEN_TTL_MS,
  PersonalTokenService,
  TOKEN_NOT_FOUND_MESSAGE,
} from './personal-token.service';

function actorFor(member: MemberRecord): Actor {
  return {
    userId: member.id,
    email: member.email,
    role: member.role,
    isOwner: member.isOwner,
    via: 'session',
    tokenId: null,
  };
}

describe('PersonalTokenService', () => {
  let storage: MemoryAdapter;
  let members: MemberService;
  let service: PersonalTokenService;
  let admin: MemberRecord;
  let member: MemberRecord;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    members = new MemberService(auth);
    admin = await members.create({
      email: 'admin@example.com',
      name: 'Admin',
      password: 'admin horse battery',
      role: 'admin',
    });
    member = await members.create({
      email: 'member@example.com',
      name: 'Member',
      password: 'member horse battery',
      role: 'member',
    });
  });

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
    service = new PersonalTokenService(storage, members);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('generates an opaque mcp token owned by the caller and stores only its hash', async () => {
    const { token, metadata } = await service.generate('laptop', actorFor(member));
    expect(token.startsWith(PERSONAL_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(PERSONAL_TOKEN_PREFIX.length + 40);
    expect(metadata).toEqual(
      expect.objectContaining({
        name: 'laptop',
        type: 'mcp',
        userId: member.id,
        revokedAt: null,
        lastUsedAt: null,
        tokenHash: hashPersonalToken(token),
      }),
    );
    expect(metadata.expiresAt - metadata.createdAt).toBe(PERSONAL_TOKEN_TTL_MS);
    const stored = await storage.getAgentTokens('mcp');
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('resolves a token to its owner with the owner role and stamps last use', async () => {
    const { token, metadata } = await service.generate('laptop', actorFor(member));
    const actor = await service.resolveActor(token);
    expect(actor).toEqual({
      userId: member.id,
      email: member.email,
      role: 'member',
      isOwner: false,
      via: 'token',
      tokenId: metadata.id,
    });
    const stored = await storage.getAgentTokenByHash(metadata.tokenHash);
    expect(stored?.lastUsedAt).toEqual(expect.any(Number));
  });

  it('still resolves the actor when the lastUsedAt write fails', async () => {
    const { token, metadata } = await service.generate('laptop', actorFor(member));
    jest.spyOn(storage, 'updateAgentTokenLastUsed').mockRejectedValueOnce(new Error('busy'));
    const actor = await service.resolveActor(token);
    expect(actor).toEqual({
      userId: member.id,
      email: member.email,
      role: 'member',
      isOwner: false,
      via: 'token',
      tokenId: metadata.id,
    });
  });

  it('resolves nothing for revoked, expired, unknown, ownerless or foreign-format tokens', async () => {
    const revoked = await service.generate('revoked', actorFor(member));
    const revokeResult = await service.revoke(revoked.metadata.id, actorFor(member));
    expect(revokeResult.changed).toBe(true);
    expect(await service.resolveActor(revoked.token)).toBeNull();

    const expiredRaw = `${PERSONAL_TOKEN_PREFIX}expired`;
    await storage.saveAgentToken({
      id: 'expired',
      name: 'expired',
      type: 'mcp',
      tokenHash: hashPersonalToken(expiredRaw),
      createdAt: 1,
      expiresAt: 2,
      revokedAt: null,
      lastUsedAt: null,
      userId: member.id,
    });
    expect(await service.resolveActor(expiredRaw)).toBeNull();

    const ownerlessRaw = `${PERSONAL_TOKEN_PREFIX}ownerless`;
    await storage.saveAgentToken({
      id: 'ownerless',
      name: 'cloud',
      type: 'mcp',
      tokenHash: hashPersonalToken(ownerlessRaw),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revokedAt: null,
      lastUsedAt: null,
      userId: null,
    });
    expect(await service.resolveActor(ownerlessRaw)).toBeNull();

    expect(await service.resolveActor(`${PERSONAL_TOKEN_PREFIX}unknown`)).toBeNull();
    expect(await service.resolveActor('eyJhbGciOiJIUzI1NiJ9.cloud.jwt')).toBeNull();
  });

  it('stops resolving a token once its owner is removed', async () => {
    const leaver = await members.create({
      email: 'leaver@example.com',
      name: 'Leaver',
      password: 'leaver horse battery',
      role: 'admin',
    });
    const { token } = await service.generate('leaver', actorFor(leaver));
    await members.remove(leaver.id);
    expect(await service.resolveActor(token)).toBeNull();
  });

  it('lists only your own tokens for members and every token with its owner for admins', async () => {
    const own = await service.generate('member-laptop', actorFor(member));
    const other = await service.generate('admin-laptop', actorFor(admin));

    const memberView = await service.list(actorFor(member));
    expect(
      memberView.map((token) => {
        return token.id;
      }),
    ).toEqual([own.metadata.id]);

    const adminView = await service.list(actorFor(admin));
    expect(adminView).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: own.metadata.id,
          userId: member.id,
          ownerEmail: member.email,
        }),
        expect.objectContaining({
          id: other.metadata.id,
          userId: admin.id,
          ownerEmail: admin.email,
        }),
      ]),
    );
    expect(JSON.stringify(adminView)).not.toContain('tokenHash');
  });

  it('lets members revoke only their own tokens and admins revoke any', async () => {
    const adminToken = await service.generate('admin-laptop', actorFor(admin));
    const memberToken = await service.generate('member-laptop', actorFor(member));

    await expect(service.revoke(adminToken.metadata.id, actorFor(member))).rejects.toThrow(
      new NotFoundException(TOKEN_NOT_FOUND_MESSAGE),
    );
    await expect(service.revoke('missing', actorFor(admin))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const firstRevoke = await service.revoke(memberToken.metadata.id, actorFor(admin));
    expect(firstRevoke.changed).toBe(true);
    const stored = await storage.getAgentTokenByHash(memberToken.metadata.tokenHash);
    expect(stored?.revokedAt).toEqual(expect.any(Number));

    const secondRevoke = await service.revoke(memberToken.metadata.id, actorFor(admin));
    expect(secondRevoke.changed).toBe(false);
    expect(secondRevoke.token.revokedAt).toEqual(expect.any(Number));
  });
});
