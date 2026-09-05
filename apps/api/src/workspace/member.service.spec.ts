import { createBetterAuth } from '../auth/better-auth.factory';
import { resolveWorkspaceConfig } from '../auth/workspace-config';
import { MemberService } from './member.service';

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
