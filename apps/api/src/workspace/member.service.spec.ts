import { ConflictException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BootstrapLock } from '../auth/bootstrap-lock';
import {
  createBetterAuth,
  runBetterAuthMigrations,
  type BetterAuthInstance,
} from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import { loadBetterSqlite3 } from '../storage/adapters/better-sqlite3-driver';
import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import {
  LIST_LIMIT,
  MEMBER_CHANGED_MESSAGE,
  MemberRecord,
  MemberService,
  OWNERSHIP_CHANGED_MESSAGE,
} from './member.service';

describe('MemberService', () => {
  let service: MemberService;
  let auth: Awaited<ReturnType<typeof createBetterAuth>>;
  let bootstrapLock: BootstrapLock;

  beforeEach(async () => {
    auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    bootstrapLock = new BootstrapLock();
    service = new MemberService(auth, bootstrapLock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createSocialOwner(): Promise<MemberRecord> {
    return service.createSocial({
      email: 'first@example.com',
      name: 'First',
      image: null,
      role: 'admin',
      isOwner: true,
      provider: 'google',
      providerAccountId: 'g-first',
    });
  }

  it('creates a member with the given role and finds it by email and id', async () => {
    const created = await service.create({
      email: 'Alice@Example.com',
      name: 'Alice',
      password: 'correct horse battery',
      role: 'admin',
    });
    expect(created).toEqual({
      id: expect.any(String),
      email: 'alice@example.com',
      name: 'Alice',
      role: 'admin',
      isOwner: false,
      createdAt: expect.any(Number),
    });
    expect(await service.findByEmail('ALICE@example.com')).toEqual(created);
    expect(await service.findById(created.id)).toEqual(created);
    expect(await service.findByEmail('nobody@example.com')).toBeNull();
    expect(await service.findById('nope')).toBeNull();
  });

  it('removes the user again when linking the credential fails', async () => {
    const context = await auth.$context;
    jest.spyOn(context.internalAdapter, 'linkAccount').mockRejectedValueOnce(new Error('boom'));
    await expect(
      service.create({
        email: 'orphan@example.com',
        name: 'Orphan',
        password: 'correct horse battery',
        role: 'member',
      }),
    ).rejects.toThrow('boom');
    expect(await service.findByEmail('orphan@example.com')).toBeNull();
    const retried = await service.create({
      email: 'orphan@example.com',
      name: 'Orphan',
      password: 'correct horse battery',
      role: 'member',
    });
    expect(retried.email).toBe('orphan@example.com');
  });

  it('lists members oldest first', async () => {
    const first = await service.create({
      email: 'a@example.com',
      name: 'A',
      password: 'correct horse battery',
      role: 'member',
    });
    const second = await service.create({
      email: 'b@example.com',
      name: 'B',
      password: 'correct horse battery',
      role: 'member',
    });
    const ids = (await service.list()).map((member) => {
      return member.id;
    });
    expect(ids).toEqual([first.id, second.id]);
  });

  it('warns when the member list is truncated at the list limit', async () => {
    const context = await auth.$context;
    const users = Array.from({ length: LIST_LIMIT }, (_, index) => {
      return { id: `u${index}`, email: `u${index}@example.com`, createdAt: 0 };
    });
    const listUsers = jest
      .spyOn(context.internalAdapter, 'listUsers')
      .mockResolvedValueOnce(users as never);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    const members = await service.list();
    expect(members).toHaveLength(LIST_LIMIT);
    expect(listUsers).toHaveBeenCalledWith(LIST_LIMIT, 0, expect.anything());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(String(LIST_LIMIT));
    warn.mockRestore();
    listUsers.mockRestore();
  });

  it('does not warn when the member list is below the list limit', async () => {
    await service.create({
      email: 'solo@example.com',
      name: 'Solo',
      password: 'correct horse battery',
      role: 'member',
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    await service.list();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('signs a created member in with a session cookie', async () => {
    await service.create({
      email: 'c@example.com',
      name: 'C',
      password: 'correct horse battery',
      role: 'member',
    });
    const response = await service.signIn('c@example.com', 'correct horse battery', new Headers());
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join('\n')).toContain('better-auth.session_token=');
  });

  it('changes roles and transfers ownership', async () => {
    const owner = await service.create({
      email: 'o@example.com',
      name: 'O',
      password: 'correct horse battery',
      role: 'admin',
    });
    const other = await service.create({
      email: 'p@example.com',
      name: 'P',
      password: 'correct horse battery',
      role: 'member',
    });
    const context = await auth.$context;
    await context.internalAdapter.updateUser(owner.id, { isOwner: true });
    await service.setRole(other.id, 'admin');
    expect((await service.findById(other.id))?.role).toBe('admin');
    await service.transferOwnership(owner.id, other.id);
    expect(await service.findById(other.id)).toEqual(
      expect.objectContaining({ role: 'admin', isOwner: true }),
    );
    expect(await service.findById(owner.id)).toEqual(
      expect.objectContaining({ role: 'admin', isOwner: false }),
    );
  });

  it('removes a member together with their credentials', async () => {
    const member = await service.create({
      email: 'r@example.com',
      name: 'R',
      password: 'correct horse battery',
      role: 'member',
    });
    await service.remove(member.id);
    expect(await service.findById(member.id)).toBeNull();
    const response = await service.signIn('r@example.com', 'correct horse battery', new Headers());
    expect(response.status).toBe(401);
  });

  it('creates a social member, counts users, and links a provider once', async () => {
    expect(await service.count()).toBe(0);
    const created = await service.createSocial({
      email: 'Social@Example.com',
      name: 'Social',
      image: 'https://example.com/avatar.png',
      role: 'admin',
      isOwner: true,
      provider: 'google',
      providerAccountId: 'google-social@example.com',
    });
    expect(created).toEqual({
      id: expect.any(String),
      email: 'social@example.com',
      name: 'Social',
      role: 'admin',
      isOwner: true,
      createdAt: expect.any(Number),
    });
    expect(await service.count()).toBe(1);

    await service.ensureProviderLink(created.id, 'github', 'github-social@example.com');
    await service.ensureProviderLink(created.id, 'github', 'github-social@example.com');

    const context = await auth.$context;
    const accounts = await context.internalAdapter.findAccountByUserId(created.id);
    expect(
      accounts.filter((account) => {
        return account.providerId === 'github';
      }),
    ).toHaveLength(1);
    expect(
      accounts.map((account) => {
        return account.providerId;
      }),
    ).toEqual(expect.arrayContaining(['google', 'github']));
  });

  it('discards the sole owner together with their accounts and sessions', async () => {
    const owner = await createSocialOwner();
    const context = await auth.$context;
    await context.internalAdapter.createSession(owner.id);
    await service.discardBootstrapOwner(owner.id);
    expect(await service.count()).toBe(0);
    expect(await context.internalAdapter.findAccountByUserId(owner.id)).toEqual([]);
    expect(await context.internalAdapter.listSessions(owner.id)).toEqual([]);
    const again = await createSocialOwner();
    expect(again.isOwner).toBe(true);
  });

  it('keeps an owner who is no longer the only user and logs why', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    const owner = await createSocialOwner();
    await addMember(service, 'second@example.com');
    await service.discardBootstrapOwner(owner.id);
    expect(await service.findById(owner.id)).toEqual(owner);
    expect(await service.count()).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(owner.id));
  });

  it('keeps a sole user who is not the owner', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    const member = await addMember(service, 'only@example.com');
    await service.discardBootstrapOwner(member);
    expect(await service.findById(member)).not.toBeNull();
  });

  it('waits for the bootstrap lock before discarding the owner', async () => {
    const owner = await createSocialOwner();
    let release: () => void = () => {
      return undefined;
    };
    const held = bootstrapLock.run(() => {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const discarded = service.discardBootstrapOwner(owner.id);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(await service.findById(owner.id)).not.toBeNull();
    release();
    await held;
    await discarded;
    expect(await service.findById(owner.id)).toBeNull();
  });
});

type AuthAdapter = Awaited<BetterAuthInstance['$context']>['adapter'];
type UpdateMany = AuthAdapter['updateMany'];

interface Workspace {
  auth: BetterAuthInstance;
  service: MemberService;
  ownerId: string;
}

async function addMember(service: MemberService, email: string): Promise<string> {
  const member = await service.create({
    email,
    name: email,
    password: 'correct horse battery',
    role: 'member',
  });
  return member.id;
}

async function ownerIds(service: MemberService): Promise<string[]> {
  const members = await service.list();
  return members
    .filter((member) => {
      return member.isOwner === true;
    })
    .map((member) => {
      return member.id;
    });
}

async function openWorkspace(handle: RawDatabaseHandle): Promise<Workspace> {
  const auth = await createBetterAuth({
    handle,
    secret: 's'.repeat(40),
    config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
  });
  await runBetterAuthMigrations(auth, handle);
  const service = new MemberService(auth, new BootstrapLock());
  const ownerId = await addMember(service, 'owner@example.com');
  const context = await auth.$context;
  await context.internalAdapter.updateUser(ownerId, { role: 'admin', isOwner: true });
  return { auth, service, ownerId };
}

interface InjectedFailures {
  transaction: jest.SpyInstance;
  updatedIds: string[];
  restore: () => void;
}

async function failUserUpdates(
  auth: BetterAuthInstance,
  failures: Map<number, string>,
): Promise<InjectedFailures> {
  const context = await auth.$context;
  let calls = 0;
  const updatedIds: string[] = [];
  function failing(original: UpdateMany): UpdateMany {
    return (data) => {
      calls += 1;
      const idClause = data.where.find((clause) => {
        return clause.field === 'id';
      });
      updatedIds.push(String(idClause?.value));
      const message = failures.get(calls);
      if (message !== undefined) {
        return Promise.reject(new Error(message));
      }
      return original(data);
    };
  }
  const originalUpdate = failing(context.adapter.updateMany.bind(context.adapter));
  const runTransaction = context.adapter.transaction.bind(context.adapter);
  const updates = jest.spyOn(context.adapter, 'updateMany').mockImplementation(originalUpdate);
  const transaction = jest.spyOn(context.adapter, 'transaction').mockImplementation(((
    callback: (trx: AuthAdapter) => Promise<unknown>,
  ) => {
    return runTransaction((trx) => {
      return callback({ ...trx, updateMany: failing(trx.updateMany.bind(trx)) } as AuthAdapter);
    });
  }) as AuthAdapter['transaction']);
  return {
    transaction,
    updatedIds,
    restore: () => {
      updates.mockRestore();
      transaction.mockRestore();
    },
  };
}

function describeOwnershipTransfer(
  name: string,
  transactional: boolean,
  open: () => Promise<RawDatabaseHandle>,
): void {
  describe(`MemberService owner guards (${name})`, () => {
    let auth: BetterAuthInstance;
    let service: MemberService;
    let ownerId: string;

    function addMemberNamed(email: string): Promise<string> {
      return addMember(service, email);
    }

    beforeEach(async () => {
      ({ auth, service, ownerId } = await openWorkspace(await open()));
    });

    it(`runs ${transactional ? 'inside one transaction' : 'without a transaction'}`, async () => {
      const target = await addMemberNamed('tx@example.com');
      const injected = await failUserUpdates(auth, new Map());
      await service.transferOwnership(ownerId, target);
      const transactionCalls = injected.transaction.mock.calls.length;
      injected.restore();
      expect(transactionCalls).toBe(transactional ? 1 : 0);
      expect(await ownerIds(service)).toEqual([target]);
    });

    it('leaves exactly one owner when two transfers race', async () => {
      const first = await addMemberNamed('first@example.com');
      const second = await addMemberNamed('second@example.com');
      const results = await Promise.allSettled([
        service.transferOwnership(ownerId, first),
        service.transferOwnership(ownerId, second),
      ]);
      const fulfilled = results.filter((result) => {
        return result.status === 'fulfilled';
      });
      const rejected = results.filter((result): result is PromiseRejectedResult => {
        return result.status === 'rejected';
      });
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toEqual(new ConflictException(OWNERSHIP_CHANGED_MESSAGE));
      const owners = await ownerIds(service);
      expect(owners).toHaveLength(1);
      expect([first, second]).toContain(owners[0]);
      expect(await service.findById(ownerId)).toEqual(
        expect.objectContaining({ role: 'admin', isOwner: false }),
      );
    });

    it('refuses a transfer from a user who is no longer the owner', async () => {
      const target = await addMemberNamed('target@example.com');
      const bystander = await addMemberNamed('bystander@example.com');
      await service.transferOwnership(ownerId, target);
      await expect(service.transferOwnership(ownerId, bystander)).rejects.toThrow(
        new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
      );
      expect(await ownerIds(service)).toEqual([target]);
      expect(await service.findById(bystander)).toEqual(
        expect.objectContaining({ role: 'member', isOwner: false }),
      );
    });

    it('keeps the owner when the target vanished before promotion', async () => {
      await expect(service.transferOwnership(ownerId, 'missing-user')).rejects.toThrow(
        new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
      );
      expect(await ownerIds(service)).toEqual([ownerId]);
    });

    it('promotes the target before releasing the old owner', async () => {
      const target = await addMemberNamed('order@example.com');
      const injected = await failUserUpdates(auth, new Map());
      await service.transferOwnership(ownerId, target);
      injected.restore();
      expect(injected.updatedIds).toEqual([target, ownerId]);
    });

    it('keeps the owner and restores the target role when releasing the owner fails', async () => {
      const target = await addMemberNamed('heir-admin@example.com');
      await service.setRole(target, 'admin');
      const injected = await failUserUpdates(auth, new Map([[2, 'release failed']]));
      await expect(service.transferOwnership(ownerId, target)).rejects.toThrow('release failed');
      injected.restore();
      expect(await ownerIds(service)).toEqual([ownerId]);
      expect(await service.findById(target)).toEqual(
        expect.objectContaining({ role: 'admin', isOwner: false }),
      );
    });

    it('discards the sole owner together with their credentials', async () => {
      await service.discardBootstrapOwner(ownerId);
      expect(await service.count()).toBe(0);
      const context = await auth.$context;
      expect(await context.internalAdapter.findAccountByUserId(ownerId)).toEqual([]);
    });

    it('keeps the owner when promoting the target fails', async () => {
      const target = await addMemberNamed('broken@example.com');
      const injected = await failUserUpdates(auth, new Map([[1, 'write failed']]));
      await expect(service.transferOwnership(ownerId, target)).rejects.toThrow('write failed');
      injected.restore();
      expect(await ownerIds(service)).toEqual([ownerId]);
      expect(await service.findById(target)).toEqual(
        expect.objectContaining({ role: 'member', isOwner: false }),
      );
    });

    it('removes a non-owner together with their credentials', async () => {
      const leaver = await addMemberNamed('leaver@example.com');
      await service.remove(leaver);
      expect(await service.findById(leaver)).toBeNull();
      const response = await service.signIn(
        'leaver@example.com',
        'correct horse battery',
        new Headers(),
      );
      expect(response.status).toBe(401);
    });

    it('refuses to remove a member who became the owner', async () => {
      const heir = await addMemberNamed('heir@example.com');
      await service.transferOwnership(ownerId, heir);
      await expect(service.remove(heir)).rejects.toThrow(
        new ConflictException(MEMBER_CHANGED_MESSAGE),
      );
      expect(await ownerIds(service)).toEqual([heir]);
      const response = await service.signIn(
        'heir@example.com',
        'correct horse battery',
        new Headers(),
      );
      expect(response.status).toBe(200);
    });

    it('leaves exactly one owner when a removal races a transfer', async () => {
      const contested = await addMemberNamed('contested@example.com');
      const results = await Promise.allSettled([
        service.transferOwnership(ownerId, contested),
        service.remove(contested),
      ]);
      const rejected = results.filter((result): result is PromiseRejectedResult => {
        return result.status === 'rejected';
      });
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      const owners = (await service.list()).filter((member) => {
        return member.isOwner === true;
      });
      expect(owners).toHaveLength(1);
      const response = await service.signIn(
        owners[0].email,
        'correct horse battery',
        new Headers(),
      );
      expect(response.status).toBe(200);
    });

    it('refuses a role change for a member who became the owner', async () => {
      const crowned = await addMemberNamed('crowned@example.com');
      await service.transferOwnership(ownerId, crowned);
      await expect(service.setRole(crowned, 'member')).rejects.toThrow(
        new ConflictException(MEMBER_CHANGED_MESSAGE),
      );
      expect(await service.findById(crowned)).toEqual(
        expect.objectContaining({ role: 'admin', isOwner: true }),
      );
    });

    it('keeps the owner an admin when a role change races a transfer', async () => {
      const raced = await addMemberNamed('raced@example.com');
      await Promise.allSettled([
        service.transferOwnership(ownerId, raced),
        service.setRole(raced, 'member'),
      ]);
      const owners = (await service.list()).filter((member) => {
        return member.isOwner === true;
      });
      expect(owners).toHaveLength(1);
      expect(owners[0].role).toBe('admin');
    });
  });
}

describe('MemberService.transferOwnership compensation (memory)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('demotes the target back to its previous role when releasing the owner fails', async () => {
    const { auth, service, ownerId } = await openWorkspace({ kind: 'memory' });
    const target = await addMember(service, 'demoted@example.com');
    const injected = await failUserUpdates(auth, new Map([[2, 'release failed']]));
    await expect(service.transferOwnership(ownerId, target)).rejects.toThrow('release failed');
    injected.restore();
    expect(injected.updatedIds).toEqual([target, ownerId, target]);
    expect(await ownerIds(service)).toEqual([ownerId]);
    expect(await service.findById(target)).toEqual(
      expect.objectContaining({ role: 'member', isOwner: false }),
    );
  });

  it('logs both errors and rethrows the original when demoting the target fails', async () => {
    const { auth, service, ownerId } = await openWorkspace({ kind: 'memory' });
    const target = await addMember(service, 'stuck@example.com');
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      return undefined;
    });
    const injected = await failUserUpdates(
      auth,
      new Map([
        [2, 'release failed'],
        [3, 'demote failed'],
      ]),
    );
    await expect(service.transferOwnership(ownerId, target)).rejects.toThrow('release failed');
    injected.restore();
    expect(logged).toHaveBeenCalledTimes(1);
    const message = String(logged.mock.calls[0][0]);
    expect(message).toContain('release failed');
    expect(message).toContain('demote failed');
  });

  it('logs the conflict and rethrows it when demoting after a lost ownership fails', async () => {
    const { auth, service } = await openWorkspace({ kind: 'memory' });
    const formerOwner = await addMember(service, 'former@example.com');
    const target = await addMember(service, 'late@example.com');
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      return undefined;
    });
    const injected = await failUserUpdates(auth, new Map([[3, 'demote failed']]));
    await expect(service.transferOwnership(formerOwner, target)).rejects.toThrow(
      new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
    );
    injected.restore();
    expect(String(logged.mock.calls[0][0])).toContain('demote failed');
  });

  it('does not touch the owner when the target vanished before promotion', async () => {
    const { auth, service, ownerId } = await openWorkspace({ kind: 'memory' });
    const injected = await failUserUpdates(auth, new Map());
    await expect(service.transferOwnership(ownerId, 'missing-user')).rejects.toThrow(
      new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
    );
    injected.restore();
    expect(injected.updatedIds).not.toContain(ownerId);
    expect(await ownerIds(service)).toEqual([ownerId]);
  });
});

describe('MemberService.remove without transactions (memory)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['session', 'account'])(
    'keeps the user when deleting their %s rows fails, so a retry completes',
    async (model) => {
      const { auth, service } = await openWorkspace({ kind: 'memory' });
      const email = `${model}-cleanup@example.com`;
      const leaver = await addMember(service, email);
      const context = await auth.$context;
      const deleteMany = context.adapter.deleteMany.bind(context.adapter);
      const failing = jest.spyOn(context.adapter, 'deleteMany').mockImplementation((data) => {
        if (data.model === model) {
          return Promise.reject(new Error(`${model} cleanup failed`));
        }
        return deleteMany(data);
      });
      await expect(service.remove(leaver)).rejects.toThrow(`${model} cleanup failed`);
      failing.mockRestore();
      expect(await service.findById(leaver)).not.toBeNull();

      await service.remove(leaver);
      expect(await service.findById(leaver)).toBeNull();
      const response = await service.signIn(email, 'correct horse battery', new Headers());
      expect(response.status).toBe(401);
    },
  );
});

describeOwnershipTransfer('memory', false, async () => {
  return { kind: 'memory' };
});

const sqliteFiles: string[] = [];

describeOwnershipTransfer('sqlite', true, async () => {
  const filepath = join(tmpdir(), `member-service-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const Database = await loadBetterSqlite3();
  return { kind: 'sqlite', db: new Database(filepath) };
});

afterAll(() => {
  for (const filepath of sqliteFiles) {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  }
});
