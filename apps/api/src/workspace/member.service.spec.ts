import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createBetterAuth,
  runBetterAuthMigrations,
  type BetterAuthInstance,
} from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import { loadBetterSqlite3 } from '../storage/adapters/better-sqlite3-driver';
import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import { MemberService, OWNERSHIP_CHANGED_MESSAGE } from './member.service';

describe('MemberService', () => {
  let service: MemberService;
  let auth: Awaited<ReturnType<typeof createBetterAuth>>;

  beforeEach(async () => {
    auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    service = new MemberService(auth);
  });

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
});

function describeOwnershipTransfer(name: string, open: () => Promise<RawDatabaseHandle>): void {
  describe(`MemberService.transferOwnership (${name})`, () => {
    let auth: BetterAuthInstance;
    let service: MemberService;
    let ownerId: string;

    async function addMember(email: string): Promise<string> {
      const member = await service.create({
        email,
        name: email,
        password: 'correct horse battery',
        role: 'member',
      });
      return member.id;
    }

    async function ownerIds(): Promise<string[]> {
      const members = await service.list();
      return members
        .filter((member) => {
          return member.isOwner === true;
        })
        .map((member) => {
          return member.id;
        });
    }

    beforeEach(async () => {
      const handle = await open();
      auth = await createBetterAuth({
        handle,
        secret: 's'.repeat(40),
        config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
      });
      await runBetterAuthMigrations(auth, handle);
      service = new MemberService(auth);
      ownerId = await addMember('owner@example.com');
      const context = await auth.$context;
      await context.internalAdapter.updateUser(ownerId, { role: 'admin', isOwner: true });
    });

    it('leaves exactly one owner when two transfers race', async () => {
      const first = await addMember('first@example.com');
      const second = await addMember('second@example.com');
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
      const owners = await ownerIds();
      expect(owners).toHaveLength(1);
      expect([first, second]).toContain(owners[0]);
      expect(await service.findById(ownerId)).toEqual(
        expect.objectContaining({ role: 'admin', isOwner: false }),
      );
    });

    it('refuses a transfer from a user who is no longer the owner', async () => {
      const target = await addMember('target@example.com');
      const bystander = await addMember('bystander@example.com');
      await service.transferOwnership(ownerId, target);
      await expect(service.transferOwnership(ownerId, bystander)).rejects.toThrow(
        new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
      );
      expect(await ownerIds()).toEqual([target]);
      expect((await service.findById(bystander))?.role).toBe('member');
    });

    it('restores the owner when the target vanished before promotion', async () => {
      await expect(service.transferOwnership(ownerId, 'missing-user')).rejects.toThrow(
        new ConflictException(OWNERSHIP_CHANGED_MESSAGE),
      );
      expect(await ownerIds()).toEqual([ownerId]);
    });

    it('restores the owner when promoting the target fails', async () => {
      const target = await addMember('broken@example.com');
      const context = await auth.$context;
      const original = context.adapter.updateMany.bind(context.adapter);
      let calls = 0;
      const spy = jest.spyOn(context.adapter, 'updateMany').mockImplementation((data) => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error('write failed'));
        }
        return original(data);
      });
      await expect(service.transferOwnership(ownerId, target)).rejects.toThrow('write failed');
      spy.mockRestore();
      expect(await ownerIds()).toEqual([ownerId]);
      expect(await service.findById(target)).toEqual(
        expect.objectContaining({ role: 'member', isOwner: false }),
      );
    });
  });
}

describeOwnershipTransfer('memory', async () => {
  return { kind: 'memory' };
});

const sqliteFiles: string[] = [];

describeOwnershipTransfer('sqlite', async () => {
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
