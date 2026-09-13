import { Controller, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ACTIVITY_CONFIG } from '../activity/activity-config';
import { ActivityInterceptor } from '../activity/activity.interceptor';
import { ActivityService } from '../activity/activity.service';
import { ActorResolver } from '../auth/actor-resolver';
import { BetterAuthController } from '../auth/better-auth.controller';
import { BETTER_AUTH, createBetterAuth } from '../auth/better-auth.factory';
import { ActorGuard } from '../auth/guards/actor.guard';
import { MutationGuard, READ_ONLY_MESSAGE } from '../auth/guards/mutation.guard';
import { SESSION_REQUIRED_MESSAGE } from '../auth/guards/require-session';
import { RolesGuard } from '../auth/guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG } from '../auth/workspace-config';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { InvitationService } from './invitation.service';
import { MemberService } from './member.service';
import { PersonalTokenService, TOKEN_NOT_FOUND_MESSAGE } from './personal-token.service';
import { PersonalTokensController } from './personal-tokens.controller';
import { WorkspaceController } from './workspace.controller';

const ORIGIN = 'http://localhost';
const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const MEMBER = { email: 'member@example.com', password: 'member horse battery', name: 'Member' };

interface CreatedToken {
  token: string;
  id: string;
  name: string;
  type: string;
  expiresAt: number;
}

interface ListedToken {
  id: string;
  name: string;
  userId: string | null;
  ownerEmail: string | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface ActivityBody {
  items: Array<{
    action: string;
    actor: { userId: string; email: string; via: string; tokenId: string | null };
    target: { type: string; id: string } | null;
    statusCode: number;
  }>;
}

function jsonHeaders(extra: Record<string, string>): Record<string, string> {
  return { 'content-type': 'application/json', origin: ORIGIN, ...extra };
}

@Controller('probe')
class ProbeController {
  @Post()
  touch(): { ok: true } {
    return { ok: true };
  }
}

describe('PersonalTokensController', () => {
  let app: NestFastifyApplication;
  let storage: MemoryAdapter;
  let ownerCookie: string;
  let ownerId: string;
  let memberCookie: string;
  let memberId: string;

  async function signIn(email: string, password: string, remoteAddress: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: jsonHeaders({}),
      payload: { email, password },
      remoteAddress,
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0];
  }

  async function createToken(cookie: string, name: string): Promise<CreatedToken> {
    const response = await app.inject({
      method: 'POST',
      url: '/agent-tokens',
      headers: jsonHeaders({ cookie }),
      payload: { name, type: 'mcp' },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as CreatedToken;
  }

  async function listTokens(cookie: string): Promise<ListedToken[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/agent-tokens?type=mcp',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ListedToken[];
  }

  async function activity(): Promise<ActivityBody> {
    const response = await app.inject({
      method: 'GET',
      url: '/workspace/activity',
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ActivityBody;
  }

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      controllers: [
        BetterAuthController,
        WorkspaceController,
        PersonalTokensController,
        ProbeController,
      ],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: UsageTelemetryService,
          useValue: {
            trackUserInvited: jest.fn(),
            trackInviteAccepted: jest.fn(),
            trackUserLogin: jest.fn(),
            trackWorkspaceFirstRegister: jest.fn(),
            trackMemberRemoved: jest.fn(),
          },
        },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
        MemberService,
        InvitationService,
        PersonalTokenService,
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

    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: jsonHeaders({}),
      payload: OWNER,
      remoteAddress: '10.1.10.1',
    });
    expect(signUp.statusCode).toBe(200);
    ownerCookie = String(signUp.headers['set-cookie']).split(';')[0];
    ownerId = (signUp.json() as { user: { id: string } }).user.id;

    const member = await app.get(MemberService).create({ ...MEMBER, role: 'member' });
    memberId = member.id;
    memberCookie = await signIn(MEMBER.email, MEMBER.password, '10.1.10.2');
  });

  afterAll(async () => {
    await app.close();
    await storage.close();
  });

  it('lets every signed-in user create a token that only its owner and admins can see', async () => {
    const own = await createToken(memberCookie, 'member-laptop');
    const adminToken = await createToken(ownerCookie, 'owner-laptop');
    expect(own.token.startsWith('bdb_mcp_')).toBe(true);
    expect(own.type).toBe('mcp');

    const memberView = await listTokens(memberCookie);
    expect(
      memberView.every((token) => {
        return token.userId === memberId;
      }),
    ).toBe(true);
    expect(
      memberView.map((token) => {
        return token.id;
      }),
    ).toContain(own.id);

    const ownerView = await listTokens(ownerCookie);
    expect(ownerView).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: own.id, userId: memberId, ownerEmail: MEMBER.email }),
        expect.objectContaining({ id: adminToken.id, userId: ownerId, ownerEmail: OWNER.email }),
      ]),
    );
    expect(JSON.stringify(ownerView)).not.toContain(own.token);
    expect(JSON.stringify(ownerView)).not.toContain('tokenHash');
  });

  it('validates the token body', async () => {
    const blank = await app.inject({
      method: 'POST',
      url: '/agent-tokens',
      headers: jsonHeaders({ cookie: ownerCookie }),
      payload: { name: '   ', type: 'mcp' },
    });
    expect(blank.statusCode).toBe(400);

    const agent = await app.inject({
      method: 'POST',
      url: '/agent-tokens',
      headers: jsonHeaders({ cookie: ownerCookie }),
      payload: { name: 'agent', type: 'agent' },
    });
    expect(agent.statusCode).toBe(400);
  });

  it('attributes a bearer mutation to the token owner in the activity log', async () => {
    const created = await createToken(ownerCookie, 'ci');
    const probe = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: jsonHeaders({ authorization: `Bearer ${created.token}` }),
      payload: {},
    });
    expect(probe.statusCode).toBe(201);

    const entry = (await activity()).items.find((item) => {
      return item.action === 'POST /probe' && item.actor.tokenId === created.id;
    });
    expect(entry?.actor).toEqual({
      userId: ownerId,
      email: OWNER.email,
      via: 'token',
      tokenId: created.id,
    });

    const listed = (await listTokens(ownerCookie)).find((token) => {
      return token.id === created.id;
    });
    expect(listed?.lastUsedAt).toEqual(expect.any(Number));
  });

  it("keeps a member's token read-only", async () => {
    const created = await createToken(memberCookie, 'member-ci');
    const me = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({ email: MEMBER.email, role: 'member' }));

    const probe = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: jsonHeaders({ authorization: `Bearer ${created.token}` }),
      payload: {},
    });
    expect(probe.statusCode).toBe(403);
    expect(probe.json().message).toBe(READ_ONLY_MESSAGE);
  });

  it('refuses to create or revoke tokens with a token', async () => {
    const created = await createToken(ownerCookie, 'no-minting');
    const mint = await app.inject({
      method: 'POST',
      url: '/agent-tokens',
      headers: jsonHeaders({ authorization: `Bearer ${created.token}` }),
      payload: { name: 'child', type: 'mcp' },
    });
    expect(mint.statusCode).toBe(403);
    expect(mint.json().message).toBe(SESSION_REQUIRED_MESSAGE);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${created.id}`,
      headers: { authorization: `Bearer ${created.token}`, origin: ORIGIN },
    });
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json().message).toBe(SESSION_REQUIRED_MESSAGE);
  });

  it('keeps identity and access changes session-only, so a token cannot plant a new account', async () => {
    const created = await createToken(ownerCookie, 'no-escalation');
    const bearer = { authorization: `Bearer ${created.token}` };

    const invite = await app.inject({
      method: 'POST',
      url: '/workspace/invite',
      headers: jsonHeaders(bearer),
      payload: { email: 'attacker@example.com', role: 'admin' },
    });
    expect(invite.statusCode).toBe(403);
    expect(invite.json().message).toBe(SESSION_REQUIRED_MESSAGE);
    expect(JSON.stringify(invite.json())).not.toContain('/invite/');

    const pending = await app.inject({
      method: 'GET',
      url: '/workspace/invitations',
      headers: { cookie: ownerCookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(JSON.stringify(pending.json())).not.toContain('attacker@example.com');

    const role = await app.inject({
      method: 'PATCH',
      url: `/workspace/members/${memberId}/role`,
      headers: jsonHeaders(bearer),
      payload: { role: 'admin' },
    });
    expect(role.statusCode).toBe(403);
    expect(role.json().message).toBe(SESSION_REQUIRED_MESSAGE);

    const transfer = await app.inject({
      method: 'POST',
      url: '/workspace/ownership/transfer',
      headers: jsonHeaders(bearer),
      payload: { userId: memberId },
    });
    expect(transfer.statusCode).toBe(403);
    expect(transfer.json().message).toBe(SESSION_REQUIRED_MESSAGE);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/workspace/members/${memberId}`,
      headers: { ...bearer, origin: ORIGIN },
    });
    expect(remove.statusCode).toBe(403);
    expect(remove.json().message).toBe(SESSION_REQUIRED_MESSAGE);

    const memberAfter = await app.inject({
      method: 'GET',
      url: '/workspace/members',
      headers: { cookie: ownerCookie },
    });
    expect(memberAfter.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: memberId, role: 'member' })]),
    );

    const invited = await app.inject({
      method: 'POST',
      url: '/workspace/invite',
      headers: jsonHeaders({ cookie: ownerCookie }),
      payload: { email: 'pending@example.com', role: 'member' },
    });
    expect(invited.statusCode).toBe(201);
    const invitationId = (invited.json() as { id: string }).id;

    const revokeInvite = await app.inject({
      method: 'DELETE',
      url: `/workspace/invitations/${invitationId}`,
      headers: { ...bearer, origin: ORIGIN },
    });
    expect(revokeInvite.statusCode).toBe(403);
    expect(revokeInvite.json().message).toBe(SESSION_REQUIRED_MESSAGE);

    const invitationsAfter = await app.inject({
      method: 'GET',
      url: '/workspace/invitations',
      headers: { cookie: ownerCookie },
    });
    expect(invitationsAfter.statusCode).toBe(200);
    expect(JSON.stringify(invitationsAfter.json())).toContain('pending@example.com');
  });

  it("applies the owner's current role to an already-issued token", async () => {
    const shifting = await app.get(MemberService).create({
      email: 'shifting@example.com',
      name: 'Shifting',
      password: 'shifting horse battery',
      role: 'admin',
    });
    const cookie = await signIn('shifting@example.com', 'shifting horse battery', '10.1.10.3');
    const created = await createToken(cookie, 'shifting');

    async function probeStatus(): Promise<number> {
      const response = await app.inject({
        method: 'POST',
        url: '/probe',
        headers: jsonHeaders({ authorization: `Bearer ${created.token}` }),
        payload: {},
      });
      return response.statusCode;
    }

    async function setRole(role: 'admin' | 'member'): Promise<void> {
      const response = await app.inject({
        method: 'PATCH',
        url: `/workspace/members/${shifting.id}/role`,
        headers: jsonHeaders({ cookie: ownerCookie }),
        payload: { role },
      });
      expect(response.statusCode).toBe(200);
    }

    expect(await probeStatus()).toBe(201);
    await setRole('member');
    expect(await probeStatus()).toBe(403);
    await setRole('admin');
    expect(await probeStatus()).toBe(201);
  });

  it("hides other people's tokens from members and lets admins revoke any", async () => {
    const ownerToken = await createToken(ownerCookie, 'owner-only');
    const hidden = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${ownerToken.id}`,
      headers: { cookie: memberCookie, origin: ORIGIN },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().message).toBe(TOKEN_NOT_FOUND_MESSAGE);

    const memberToken = await createToken(memberCookie, 'member-revoked-by-admin');
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${memberToken.id}`,
      headers: { cookie: ownerCookie, origin: ORIGIN },
    });
    expect(revoked.statusCode).toBe(200);
  });

  it('records token creation and revocation, and a revoked token stops working', async () => {
    const created = await createToken(memberCookie, 'short-lived');
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${created.id}`,
      headers: { cookie: memberCookie, origin: ORIGIN },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ revoked: true });

    const me = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(me.statusCode).toBe(401);

    const actions = (await activity()).items
      .filter((item) => {
        return item.target !== null && item.target.id === created.id;
      })
      .map((item) => {
        return item.action;
      });
    expect([...actions].sort()).toEqual(['token.create', 'token.revoke']);
  });

  it('records only one token.revoke row when a token is revoked twice', async () => {
    const created = await createToken(memberCookie, 'revoked-twice');
    const firstRevoke = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${created.id}`,
      headers: { cookie: memberCookie, origin: ORIGIN },
    });
    expect(firstRevoke.statusCode).toBe(200);
    expect(firstRevoke.json()).toEqual({ revoked: true });

    const secondRevoke = await app.inject({
      method: 'DELETE',
      url: `/agent-tokens/${created.id}`,
      headers: { cookie: memberCookie, origin: ORIGIN },
    });
    expect(secondRevoke.statusCode).toBe(200);
    expect(secondRevoke.json()).toEqual({ revoked: true });

    const revokeRows = (await activity()).items.filter((item) => {
      return item.action === 'token.revoke' && item.target?.id === created.id;
    });
    expect(revokeRows).toHaveLength(1);
  });
});
