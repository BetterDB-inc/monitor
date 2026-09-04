import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ACTIVITY_CONFIG } from '../activity/activity-config';
import { ActivityInterceptor } from '../activity/activity.interceptor';
import { ActivityService, INVALID_CURSOR_MESSAGE } from '../activity/activity.service';
import { ActorResolver } from '../auth/actor-resolver';
import { BetterAuthController } from '../auth/better-auth.controller';
import { BETTER_AUTH, createBetterAuth } from '../auth/better-auth.factory';
import { ActorGuard } from '../auth/guards/actor.guard';
import { MutationGuard, READ_ONLY_MESSAGE } from '../auth/guards/mutation.guard';
import {
  OWNER_REQUIRED_MESSAGE,
  ROLE_REQUIRED_MESSAGE,
  RolesGuard,
} from '../auth/guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG } from '../auth/workspace-config';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { InvitationService, PENDING_EXISTS_MESSAGE } from './invitation.service';
import { InviteController } from './invite.controller';
import { MemberService } from './member.service';
import { WorkspaceController } from './workspace.controller';

const ORIGIN = 'http://localhost';
const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };

describe('WorkspaceController', () => {
  let app: NestFastifyApplication;
  let members: MemberService;
  let telemetry: { trackUserInvited: jest.Mock; trackInviteAccepted: jest.Mock };
  let ownerCookie: string;

  async function signIn(email: string, password: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { email, password },
      remoteAddress: '10.1.9.2',
    });
    return String(response.headers['set-cookie']).split(';')[0];
  }

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    const storage = new MemoryAdapter();
    await storage.initialize();
    telemetry = { trackUserInvited: jest.fn(), trackInviteAccepted: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController, WorkspaceController, InviteController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: UsageTelemetryService, useValue: telemetry },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
        MemberService,
        InvitationService,
        { provide: APP_GUARD, useClass: ActorGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: MutationGuard },
        { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    members = app.get(MemberService);

    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: OWNER,
      remoteAddress: '10.1.9.1',
    });
    ownerCookie = String(signUp.headers['set-cookie']).split(';')[0];
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /workspace/me', () => {
    it('returns 401 without a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/workspace/me' });
      expect(response.statusCode).toBe(401);
    });

    it('returns the signed-in owner', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        userId: expect.any(String),
        email: OWNER.email,
        name: OWNER.name,
        role: 'admin',
        isOwner: true,
      });
    });
  });

  describe('invitations', () => {
    it('lets the owner invite, list and revoke', async () => {
      const invite = await app.inject({
        method: 'POST',
        url: '/workspace/invite',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { email: 'Invitee@Example.com', role: 'member' },
      });
      expect(invite.statusCode).toBe(201);
      const created = invite.json() as { id: string; email: string; url: string; status: string };
      expect(created).toEqual(
        expect.objectContaining({
          email: 'invitee@example.com',
          role: 'member',
          status: 'pending',
          url: expect.stringMatching(/^http:\/\/localhost\/invite\/[A-Za-z0-9_-]{43}$/),
        }),
      );
      expect(telemetry.trackUserInvited).toHaveBeenCalledWith({ role: 'member' });

      const duplicate = await app.inject({
        method: 'POST',
        url: '/workspace/invite',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { email: 'invitee@example.com', role: 'admin' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual(
        expect.objectContaining({ message: PENDING_EXISTS_MESSAGE }),
      );

      const list = await app.inject({
        method: 'GET',
        url: '/workspace/invitations',
        headers: { cookie: ownerCookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([
        expect.objectContaining({
          id: created.id,
          status: 'pending',
          invitedBy: expect.any(String),
        }),
      ]);
      expect(JSON.stringify(list.json())).not.toContain('tokenHash');
      expect(JSON.stringify(list.json())).not.toContain('url');

      const revoke = await app.inject({
        method: 'DELETE',
        url: `/workspace/invitations/${created.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(revoke.statusCode).toBe(200);
      const after = await app.inject({
        method: 'GET',
        url: '/workspace/invitations',
        headers: { cookie: ownerCookie },
      });
      expect(after.json()).toEqual([
        expect.objectContaining({ id: created.id, status: 'revoked' }),
      ]);
    });

    it('rejects an invalid invite body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/workspace/invite',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { email: 'not-an-email', role: 'owner' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('members', () => {
    let memberCookie: string;
    let memberId: string;

    beforeAll(async () => {
      const member = await members.create({
        email: 'member@example.com',
        name: 'Member',
        password: 'member horse battery',
        role: 'member',
      });
      memberId = member.id;
      memberCookie = await signIn('member@example.com', 'member horse battery');
    });

    it('lists members for everyone signed in, oldest first', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/workspace/members',
        headers: { cookie: memberCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({ email: OWNER.email, role: 'admin', isOwner: true }),
        expect.objectContaining({
          id: memberId,
          email: 'member@example.com',
          role: 'member',
          isOwner: false,
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ]);
    });

    it('keeps members out of invitations and mutations', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/workspace/invitations',
        headers: { cookie: memberCookie },
      });
      expect(list.statusCode).toBe(403);
      expect(list.json()).toEqual(expect.objectContaining({ message: ROLE_REQUIRED_MESSAGE }));

      const invite = await app.inject({
        method: 'POST',
        url: '/workspace/invite',
        headers: { cookie: memberCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { email: 'x@example.com', role: 'member' },
      });
      expect(invite.statusCode).toBe(403);
      expect([ROLE_REQUIRED_MESSAGE, READ_ONLY_MESSAGE]).toContain(invite.json().message);
    });

    it('lets only the owner change roles, transfer ownership and remove members', async () => {
      const admin = await members.create({
        email: 'admin@example.com',
        name: 'Admin',
        password: 'admin horse battery',
        role: 'admin',
      });
      const adminCookie = await signIn('admin@example.com', 'admin horse battery');

      const denied = await app.inject({
        method: 'PATCH',
        url: `/workspace/members/${memberId}/role`,
        headers: { cookie: adminCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { role: 'admin' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual(expect.objectContaining({ message: OWNER_REQUIRED_MESSAGE }));

      const promoted = await app.inject({
        method: 'PATCH',
        url: `/workspace/members/${memberId}/role`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { role: 'admin' },
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toEqual(expect.objectContaining({ id: memberId, role: 'admin' }));

      const me = await app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: ownerCookie },
      });
      const ownerId = (me.json() as { userId: string }).userId;
      const selfRole = await app.inject({
        method: 'PATCH',
        url: `/workspace/members/${ownerId}/role`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { role: 'member' },
      });
      expect(selfRole.statusCode).toBe(400);
      expect(selfRole.json()).toEqual(
        expect.objectContaining({ message: 'Cannot change your own role' }),
      );

      const selfRemove = await app.inject({
        method: 'DELETE',
        url: `/workspace/members/${ownerId}`,
        headers: { cookie: ownerCookie },
      });
      expect(selfRemove.statusCode).toBe(400);
      expect(selfRemove.json()).toEqual(
        expect.objectContaining({ message: 'Cannot remove yourself' }),
      );

      const missing = await app.inject({
        method: 'DELETE',
        url: '/workspace/members/does-not-exist',
        headers: { cookie: ownerCookie },
      });
      expect(missing.statusCode).toBe(404);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/workspace/members/${admin.id}`,
        headers: { cookie: ownerCookie },
      });
      expect(removed.statusCode).toBe(200);
      const afterRemoval = await app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: adminCookie },
      });
      expect(afterRemoval.statusCode).toBe(401);

      const transfer = await app.inject({
        method: 'POST',
        url: '/workspace/ownership/transfer',
        headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: ORIGIN },
        payload: { userId: memberId },
      });
      expect(transfer.statusCode).toBe(201);
      const newOwner = await app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: memberCookie },
      });
      expect(newOwner.json()).toEqual(expect.objectContaining({ role: 'admin', isOwner: true }));
      const oldOwner = await app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: ownerCookie },
      });
      expect(oldOwner.json()).toEqual(expect.objectContaining({ role: 'admin', isOwner: false }));

      const removeOwner = await app.inject({
        method: 'DELETE',
        url: `/workspace/members/${memberId}`,
        headers: { cookie: ownerCookie },
      });
      expect(removeOwner.statusCode).toBe(403);
    });
  });

  describe('activity', () => {
    interface PageBody {
      items: Array<{
        id: string;
        occurredAt: string;
        actor: { userId: string; email: string; via: string; tokenId: string | null };
        action: string;
        target: { type: string; id: string } | null;
        statusCode: number;
        details: Record<string, unknown>;
      }>;
      nextCursor: string | null;
    }

    let readerCookie: string;

    beforeAll(async () => {
      await members.create({
        email: 'reader@example.com',
        name: 'Reader',
        password: 'reader horse battery',
        role: 'member',
      });
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        payload: { email: 'reader@example.com', password: 'reader horse battery' },
        remoteAddress: '10.1.9.3',
      });
      expect(response.statusCode).toBe(200);
      readerCookie = String(response.headers['set-cookie']).split(';')[0];
    });

    it('lists recorded mutations newest first for admins', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/workspace/activity',
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as PageBody;
      expect(body.items.length).toBeGreaterThan(1);
      const invite = body.items.find((item) => {
        return item.action === 'member.invite' && item.statusCode === 201;
      });
      expect(invite).toBeDefined();
      const rejected = body.items.find((item) => {
        return item.action === 'member.invite' && item.statusCode === 400;
      });
      expect(rejected?.target).toBeNull();
      expect(invite?.statusCode).toBe(201);
      expect(invite?.target?.type).toBe('invitation');
      expect(invite?.actor.email).toBe(OWNER.email);
      expect(invite?.details).toEqual({ method: 'POST', path: '/workspace/invite' });
      for (let i = 1; i < body.items.length; i += 1) {
        expect(Date.parse(body.items[i - 1].occurredAt)).toBeGreaterThanOrEqual(
          Date.parse(body.items[i].occurredAt),
        );
      }
    });

    it('pages with the cursor and rejects an oversized limit', async () => {
      const first = await app.inject({
        method: 'GET',
        url: '/workspace/activity?limit=1',
        headers: { cookie: ownerCookie },
      });
      const firstBody = first.json() as PageBody;
      expect(firstBody.items).toHaveLength(1);
      expect(typeof firstBody.nextCursor).toBe('string');
      const second = await app.inject({
        method: 'GET',
        url: `/workspace/activity?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
        headers: { cookie: ownerCookie },
      });
      const secondBody = second.json() as PageBody;
      expect(secondBody.items).toHaveLength(1);
      expect(secondBody.items[0].id).not.toBe(firstBody.items[0].id);
      const tooBig = await app.inject({
        method: 'GET',
        url: '/workspace/activity?limit=1000',
        headers: { cookie: ownerCookie },
      });
      expect(tooBig.statusCode).toBe(400);
    });

    it('filters by actor, action and time window', async () => {
      const byAction = await app.inject({
        method: 'GET',
        url: '/workspace/activity?action=member.invite',
        headers: { cookie: ownerCookie },
      });
      const actions = (byAction.json() as PageBody).items.map((item) => {
        return item.action;
      });
      expect(actions.length).toBeGreaterThan(0);
      expect(new Set(actions)).toEqual(new Set(['member.invite']));
      const future = new Date(Date.now() + 60_000).toISOString();
      const none = await app.inject({
        method: 'GET',
        url: `/workspace/activity?from=${encodeURIComponent(future)}`,
        headers: { cookie: ownerCookie },
      });
      expect((none.json() as PageBody).items).toEqual([]);
      const badTime = await app.inject({
        method: 'GET',
        url: '/workspace/activity?from=yesterday',
        headers: { cookie: ownerCookie },
      });
      expect(badTime.statusCode).toBe(400);
    });

    it('rejects a malformed cursor', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/workspace/activity?cursor=%21%21',
        headers: { cookie: ownerCookie },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { message: string }).message).toBe(INVALID_CURSOR_MESSAGE);
    });

    it('is admin-only', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/workspace/activity',
        headers: { cookie: readerCookie },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
