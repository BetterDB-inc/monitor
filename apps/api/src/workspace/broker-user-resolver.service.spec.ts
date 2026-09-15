import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BootstrapLock } from '../auth/bootstrap-lock';
import { BETTER_AUTH, createBetterAuth } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG } from '../auth/workspace-config';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import {
  BrokerIdentity,
  BrokerNotInvitedError,
  BrokerUserResolver,
} from './broker-user-resolver.service';
import { hashInvitationToken, InvitationService } from './invitation.service';
import { MemberService } from './member.service';

function identity(email: string, provider: 'google' | 'github' = 'google'): BrokerIdentity {
  return { email, name: 'Person', avatarUrl: null, provider, providerId: `${provider}-${email}` };
}

describe('BrokerUserResolver', () => {
  let resolver: BrokerUserResolver;
  let members: MemberService;
  let invitations: InvitationService;
  let storage: MemoryAdapter;
  let accountsOf: (userId: string) => Promise<string[]>;
  let currentTime = Date.now();

  beforeEach(async () => {
    currentTime = Date.now();
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: 'INVITATION_CLOCK',
          useValue: (): number => {
            return currentTime;
          },
        },
        BootstrapLock,
        MemberService,
        InvitationService,
        BrokerUserResolver,
      ],
    }).compile();
    resolver = moduleRef.get(BrokerUserResolver);
    members = moduleRef.get(MemberService);
    invitations = moduleRef.get(InvitationService);
    accountsOf = async (userId: string): Promise<string[]> => {
      const context = await auth.$context;
      const accounts = await context.internalAdapter.findAccountByUserId(userId);
      return accounts.map((account) => {
        return account.providerId;
      });
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });

  async function invitationStatus(id: string): Promise<string | undefined> {
    const rows = await invitations.list();
    return rows.find((row) => {
      return row.id === id;
    })?.status;
  }

  async function invite(email: string): Promise<{ id: string; token: string }> {
    const owner = await resolver.resolve(identity('owner@example.com'), null);
    const created = await invitations.create({
      email,
      role: 'member',
      invitedBy: owner.member.id,
    });
    return { id: created.invitation.id, token: created.token };
  }

  function silenceErrors(): jest.SpyInstance {
    return jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      return undefined;
    });
  }

  async function failingSession(): Promise<Response> {
    throw new Error('session down');
  }

  it('keeps the invitation accepted and rethrows the session error when removal fails', async () => {
    const invited = await invite('invitee@example.com');
    const errorLog = silenceErrors();
    jest.spyOn(members, 'remove').mockRejectedValueOnce(new Error('member vanished'));
    await expect(
      resolver.signIn(identity('invitee@example.com'), null, failingSession),
    ).rejects.toThrow('session down');
    expect(await members.findByEmail('invitee@example.com')).not.toBeNull();
    expect(await invitationStatus(invited.id)).toBe('accepted');
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('invitee@example.com'),
      expect.stringContaining('member vanished'),
    );
  });

  it('logs a release that finds the invitation no longer accepted', async () => {
    const invited = await invite('invitee@example.com');
    const errorLog = silenceErrors();
    jest.spyOn(invitations, 'release').mockResolvedValueOnce(false);
    await expect(
      resolver.signIn(identity('invitee@example.com'), null, failingSession),
    ).rejects.toThrow('session down');
    expect(await members.findByEmail('invitee@example.com')).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(invited.id));
  });

  it('keeps the member creation error when releasing the invitation fails', async () => {
    const invited = await invite('invitee@example.com');
    const errorLog = silenceErrors();
    jest.spyOn(members, 'createSocial').mockRejectedValueOnce(new Error('email taken'));
    jest.spyOn(invitations, 'release').mockRejectedValueOnce(new Error('disk full'));
    await expect(resolver.resolve(identity('invitee@example.com'), null)).rejects.toThrow(
      'email taken',
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${invited.id}.*disk full`)),
    );
  });

  async function startedSession(): Promise<Response> {
    return new Response(null, { status: 200 });
  }

  async function refusedSession(): Promise<Response> {
    return new Response(null, { status: 500 });
  }

  async function raceReinvite(email: string): Promise<() => string> {
    const invited = await invite(email);
    const owner = await members.findByEmail('owner@example.com');
    const createSocial = members.createSocial.bind(members);
    let racedToken = '';
    jest.spyOn(members, 'createSocial').mockImplementationOnce(async (input) => {
      await invitations.revoke(invited.id);
      const raced = await invitations.create({
        email,
        role: 'member',
        invitedBy: String(owner?.id),
      });
      racedToken = raced.token;
      return createSocial(input);
    });
    return () => {
      return racedToken;
    };
  }

  async function rowsFor(email: string): Promise<string[]> {
    return (await invitations.list())
      .filter((row) => {
        return row.email === email;
      })
      .map((row) => {
        return row.status;
      });
  }

  it('revokes a re-invite that raced a broker invite sign-in', async () => {
    await raceReinvite('raced@example.com');
    const signedIn = await resolver.signIn(identity('raced@example.com'), null, startedSession);
    expect(signedIn.resolved.entrance).toBe('invite');
    expect(signedIn.session.ok).toBe(true);
    expect(await members.findByEmail('raced@example.com')).not.toBeNull();
    expect(await rowsFor('raced@example.com')).not.toContain('pending');
  });

  it('still signs the invitee in and logs when revoking a raced re-invite fails', async () => {
    await invite('invitee@example.com');
    const errorLog = silenceErrors();
    jest.spyOn(invitations, 'revokeRacedReinvite').mockRejectedValueOnce(new Error('disk full'));
    const signedIn = await resolver.signIn(identity('invitee@example.com'), null, startedSession);
    expect(signedIn.session.ok).toBe(true);
    expect(await members.findByEmail('invitee@example.com')).not.toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('keeps a re-invite that raced a broker invite sign-in which then rolled back', async () => {
    const racedToken = await raceReinvite('raced@example.com');
    silenceErrors();
    const failed = await resolver.signIn(identity('raced@example.com'), null, refusedSession);
    expect(failed.session.ok).toBe(false);
    expect(await members.findByEmail('raced@example.com')).toBeNull();
    expect(await rowsFor('raced@example.com')).toEqual(['pending']);

    const retried = await resolver.signIn(
      identity('raced@example.com'),
      hashInvitationToken(racedToken()),
      startedSession,
    );
    expect(retried.resolved.entrance).toBe('invite');
    expect(await members.findByEmail('raced@example.com')).not.toBeNull();
  });

  it('makes the first broker user the owner', async () => {
    const result = await resolver.resolve(identity('owner@example.com'), null);
    expect(result.entrance).toBe('register');
    expect(result.member).toMatchObject({
      email: 'owner@example.com',
      role: 'admin',
      isOwner: true,
    });
    expect(await accountsOf(result.member.id)).toEqual(['google']);
  });

  it('signs an existing user in and links the provider once', async () => {
    const owner = await resolver.resolve(identity('owner@example.com'), null);
    const again = await resolver.resolve(identity('owner@example.com', 'github'), null);
    const thrice = await resolver.resolve(identity('owner@example.com', 'github'), null);
    expect(again.entrance).toBe('login');
    expect(thrice.member.id).toBe(owner.member.id);
    expect((await accountsOf(owner.member.id)).sort()).toEqual(['github', 'google']);
  });

  it('links a provider to an existing password account', async () => {
    await resolver.resolve(identity('owner@example.com'), null);
    const password = await members.create({
      email: 'pw@example.com',
      name: 'Pw',
      password: 'correct horse battery',
      role: 'member',
    });
    const result = await resolver.resolve(identity('PW@example.com'), null);
    expect(result).toMatchObject({ entrance: 'login', member: { id: password.id } });
    expect((await accountsOf(password.id)).sort()).toEqual(['credential', 'google']);
  });

  it('creates an invited member with the invitation role and accepts the invitation', async () => {
    const owner = await resolver.resolve(identity('owner@example.com'), null);
    const { invitation } = await invitations.create({
      email: 'invitee@example.com',
      role: 'admin',
      invitedBy: owner.member.id,
    });
    const result = await resolver.resolve(identity('invitee@example.com'), null);
    expect(result.entrance).toBe('invite');
    expect(result.invitation?.id).toBe(invitation.id);
    expect(result.member).toMatchObject({ role: 'admin', isOwner: false });
    const stored = (await invitations.list()).find((row) => {
      return row.id === invitation.id;
    });
    expect(stored?.status).toBe('accepted');
  });

  it('requires a supplied invite token to match the invitation', async () => {
    const owner = await resolver.resolve(identity('owner@example.com'), null);
    const { invitation } = await invitations.create({
      email: 'invitee@example.com',
      role: 'member',
      invitedBy: owner.member.id,
    });
    await expect(
      resolver.resolve(identity('invitee@example.com'), hashInvitationToken('other')),
    ).rejects.toBeInstanceOf(BrokerNotInvitedError);
    const stored = (await invitations.list()).find((row) => {
      return row.id === invitation.id;
    });
    expect(stored?.status).toBe('pending');
  });

  it('rejects an uninvited stranger and creates nobody', async () => {
    await resolver.resolve(identity('owner@example.com'), null);
    await expect(resolver.resolve(identity('stranger@example.com'), null)).rejects.toBeInstanceOf(
      BrokerNotInvitedError,
    );
    expect(await members.findByEmail('stranger@example.com')).toBeNull();
  });

  it('rejects an expired invitation and leaves it pending', async () => {
    const owner = await resolver.resolve(identity('owner@example.com'), null);
    const { invitation } = await invitations.create({
      email: 'late@example.com',
      role: 'member',
      invitedBy: owner.member.id,
    });
    currentTime += 8 * 24 * 60 * 60 * 1000;
    await expect(resolver.resolve(identity('late@example.com'), null)).rejects.toBeInstanceOf(
      BrokerNotInvitedError,
    );
    const stored = (await invitations.list()).find((row) => {
      return row.id === invitation.id;
    });
    expect(stored?.status).toBe('pending');
  });

  it('creates exactly one owner when two first sign-ins race', async () => {
    const [first, second] = await Promise.allSettled([
      resolver.resolve(identity('a@example.com'), null),
      resolver.resolve(identity('b@example.com'), null),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const owners = (await members.list()).filter((member) => {
      return member.isOwner === true;
    });
    expect(owners).toHaveLength(1);
  });

  it('still serves a later sign-in after an earlier one was rejected', async () => {
    await resolver.resolve(identity('owner@example.com'), null);
    const [rejected, served] = await Promise.allSettled([
      resolver.resolve(identity('stranger@example.com'), null),
      resolver.resolve(identity('owner@example.com'), null),
    ]);
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(BrokerNotInvitedError);
    }
    expect(served.status).toBe('fulfilled');
    if (served.status === 'fulfilled') {
      expect(served.value.entrance).toBe('login');
    }
  });
});
