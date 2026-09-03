import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ActorResolver } from '../auth/actor-resolver';
import { BetterAuthController } from '../auth/better-auth.controller';
import { BETTER_AUTH, createBetterAuth } from '../auth/better-auth.factory';
import { ActorGuard } from '../auth/guards/actor.guard';
import { MutationGuard } from '../auth/guards/mutation.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG } from '../auth/workspace-config';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import {
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_TTL_MS,
  InvitationService,
} from './invitation.service';
import { InviteController, SIGN_IN_FAILED_MESSAGE } from './invite.controller';
import { MemberService } from './member.service';
import { WorkspaceController } from './workspace.controller';

const ORIGIN = 'http://localhost';

describe('InviteController', () => {
  let app: NestFastifyApplication;
  let invitations: InvitationService;
  let members: MemberService;
  let telemetry: { trackUserInvited: jest.Mock; trackInviteAccepted: jest.Mock };
  let ownerId: string;
  let currentTime = Date.now();

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
        {
          provide: 'INVITATION_CLOCK',
          useValue: (): number => {
            return currentTime;
          },
        },
        ActorResolver,
        MemberService,
        InvitationService,
        { provide: APP_GUARD, useClass: ActorGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: MutationGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    invitations = app.get(InvitationService);
    members = app.get(MemberService);

    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' },
      remoteAddress: '10.1.9.1',
    });
    const me = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { cookie: String(signUp.headers['set-cookie']).split(';')[0] },
    });
    ownerId = (me.json() as { userId: string }).userId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('previews a pending invitation without a session', async () => {
    const { token } = await invitations.create({
      email: 'preview@example.com',
      role: 'admin',
      invitedBy: ownerId,
    });
    const response = await app.inject({ method: 'GET', url: `/invite/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: 'preview@example.com',
      role: 'admin',
      expired: false,
    });
  });

  it('answers 404 for an unknown token', async () => {
    const response = await app.inject({ method: 'GET', url: '/invite/unknown-token' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(
      expect.objectContaining({ message: INVITATION_NOT_FOUND_MESSAGE }),
    );
  });

  it('accepts an invitation, creates the user with the invited role and signs them in', async () => {
    const { token, invitation } = await invitations.create({
      email: 'joiner@example.com',
      role: 'admin',
      invitedBy: ownerId,
    });
    const accept = await app.inject({
      method: 'POST',
      url: `/invite/${token}/accept`,
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { name: 'Joiner', password: 'joiner horse battery' },
    });
    expect(accept.statusCode).toBe(201);
    expect(accept.json()).toEqual({
      userId: expect.any(String),
      email: 'joiner@example.com',
      name: 'Joiner',
      role: 'admin',
      isOwner: false,
    });
    const cookie = String(accept.headers['set-cookie']).split(';')[0];
    expect(cookie).toContain('better-auth.session_token=');
    expect(telemetry.trackInviteAccepted).toHaveBeenCalledWith({
      role: 'admin',
      method: 'password',
    });

    const me = await app.inject({ method: 'GET', url: '/workspace/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(
      expect.objectContaining({ email: 'joiner@example.com', role: 'admin', isOwner: false }),
    );

    const again = await app.inject({
      method: 'POST',
      url: `/invite/${token}/accept`,
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { name: 'Joiner', password: 'joiner horse battery' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual(expect.objectContaining({ message: 'Invitation is accepted' }));

    const list = await invitations.list();
    expect(list.find((item) => item.id === invitation.id)?.status).toBe('accepted');
  });

  it('rejects a weak password and leaves the invitation pending', async () => {
    const { token, invitation } = await invitations.create({
      email: 'weak@example.com',
      role: 'member',
      invitedBy: ownerId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/invite/${token}/accept`,
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { name: 'Weak', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    const list = await invitations.list();
    expect(list.find((item) => item.id === invitation.id)?.status).toBe('pending');
  });

  it('keeps the public registration closed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { email: 'walkin@example.com', password: 'walkin horse battery', name: 'Walk-in' },
      remoteAddress: '10.1.9.3',
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects accepting an expired invitation and leaves it pending', async () => {
    const { token, invitation } = await invitations.create({
      email: 'expired@example.com',
      role: 'member',
      invitedBy: ownerId,
    });
    const before = currentTime;
    currentTime = before + INVITATION_TTL_MS + 1000;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/invite/${token}/accept`,
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        payload: { name: 'Late', password: 'late horse battery' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        expect.objectContaining({ message: INVITATION_EXPIRED_MESSAGE }),
      );
      const list = await invitations.list();
      expect(list.find((item) => item.id === invitation.id)?.status).toBe('pending');
    } finally {
      currentTime = before;
    }
  });

  it('rejects accepting a revoked invitation', async () => {
    const { token, invitation } = await invitations.create({
      email: 'revoked@example.com',
      role: 'member',
      invitedBy: ownerId,
    });
    await invitations.revoke(invitation.id);
    const response = await app.inject({
      method: 'POST',
      url: `/invite/${token}/accept`,
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { name: 'Gone', password: 'gone horse battery' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(expect.objectContaining({ message: 'Invitation is revoked' }));
  });

  it('releases the invitation and answers 401 without a cookie when sign-in fails after account creation', async () => {
    const signInSpy = jest
      .spyOn(members, 'signIn')
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    try {
      const { token, invitation } = await invitations.create({
        email: 'failed-signin@example.com',
        role: 'member',
        invitedBy: ownerId,
      });
      const accept = await app.inject({
        method: 'POST',
        url: `/invite/${token}/accept`,
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        payload: { name: 'Failed', password: 'failed horse battery' },
      });
      expect(accept.statusCode).toBe(401);
      expect(accept.json()).toEqual(expect.objectContaining({ message: SIGN_IN_FAILED_MESSAGE }));
      expect(accept.headers['set-cookie']).toBeUndefined();

      const preview = await app.inject({ method: 'GET', url: `/invite/${token}` });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual({
        email: 'failed-signin@example.com',
        role: 'member',
        expired: false,
      });

      const list = await invitations.list();
      expect(list.find((item) => item.id === invitation.id)?.status).toBe('pending');

      expect(await members.findByEmail('failed-signin@example.com')).toBeNull();

      const retry = await app.inject({
        method: 'POST',
        url: `/invite/${token}/accept`,
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        payload: { name: 'Failed', password: 'failed horse battery' },
      });
      expect(retry.statusCode).toBe(201);
    } finally {
      signInSpy.mockRestore();
    }
  });

  it('forwards the request IP rather than a client-supplied one to sign-in', async () => {
    const signInSpy = jest.spyOn(members, 'signIn');
    try {
      const { token } = await invitations.create({
        email: 'ip-check@example.com',
        role: 'member',
        invitedBy: ownerId,
      });
      const accept = await app.inject({
        method: 'POST',
        url: `/invite/${token}/accept`,
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-betterdb-client-ip': '203.0.113.9',
        },
        payload: { name: 'IP Check', password: 'ip check horse battery' },
      });
      expect(accept.statusCode).toBe(201);
      expect(signInSpy).toHaveBeenCalledTimes(1);
      const headers = signInSpy.mock.calls[0][2];
      expect(headers.get('x-betterdb-client-ip')).toBe('127.0.0.1');
      expect(headers.get('x-betterdb-client-ip')).not.toBe('203.0.113.9');
    } finally {
      signInSpy.mockRestore();
    }
  });
});
