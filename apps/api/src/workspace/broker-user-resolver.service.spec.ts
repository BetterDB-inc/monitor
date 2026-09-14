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
    await storage.close();
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
