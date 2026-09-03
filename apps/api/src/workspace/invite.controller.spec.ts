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
import { INVITATION_NOT_FOUND_MESSAGE, InvitationService } from './invitation.service';
import { InviteController } from './invite.controller';
import { MemberService } from './member.service';
import { WorkspaceController } from './workspace.controller';

const ORIGIN = 'http://localhost';

describe('InviteController', () => {
  let app: NestFastifyApplication;
  let invitations: InvitationService;
  let telemetry: { trackUserInvited: jest.Mock; trackInviteAccepted: jest.Mock };
  let ownerId: string;

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
});
