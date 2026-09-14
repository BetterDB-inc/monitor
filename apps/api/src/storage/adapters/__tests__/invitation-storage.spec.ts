import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  InvitationRecord,
  InvitationRepository,
} from '../../../common/interfaces/invitation-repository.interface';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

function record(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: randomUUID(),
    email: 'invitee@example.com',
    role: 'member',
    tokenHash: randomUUID(),
    invitedBy: 'owner-id',
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

function describeRepository(name: string, open: () => Promise<StoragePort>): void {
  describe(`InvitationRepository (${name})`, () => {
    let storage: StoragePort;
    let repository: InvitationRepository;

    beforeEach(async () => {
      storage = await open();
      repository = storage.getInvitationRepository();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('saves and finds a record by id, email and token hash', async () => {
      const saved = record();
      await repository.save(saved);
      expect(await repository.findById(saved.id)).toEqual(saved);
      expect(await repository.findByEmail(saved.email)).toEqual(saved);
      expect(await repository.findByTokenHash(saved.tokenHash)).toEqual(saved);
    });

    it('returns null for unknown lookups', async () => {
      expect(await repository.findById('nope')).toBeNull();
      expect(await repository.findByEmail('nobody@example.com')).toBeNull();
      expect(await repository.findByTokenHash('nope')).toBeNull();
    });

    it('lists newest first', async () => {
      await repository.save(record({ email: 'a@example.com', createdAt: 10 }));
      await repository.save(record({ email: 'b@example.com', createdAt: 30 }));
      await repository.save(record({ email: 'c@example.com', createdAt: 20 }));
      const emails = (await repository.list()).map((item) => {
        return item.email;
      });
      expect(emails).toEqual(['b@example.com', 'c@example.com', 'a@example.com']);
    });

    it('replaces the row when saving the same email again', async () => {
      const first = record({ status: 'revoked' });
      await repository.save(first);
      const second = record({
        email: first.email,
        role: 'admin',
        createdAt: 5_000,
        expiresAt: 6_000,
      });
      await repository.save(second);
      expect(await repository.list()).toEqual([second]);
      expect(await repository.findById(first.id)).toBeNull();
      expect(await repository.findByTokenHash(first.tokenHash)).toBeNull();
    });

    it('changes status only from the expected status', async () => {
      const saved = record();
      await repository.save(saved);
      expect(await repository.updateStatus(saved.id, 'pending', 'accepted')).toBe(true);
      expect(await repository.updateStatus(saved.id, 'pending', 'revoked')).toBe(false);
      expect(await repository.updateStatus('missing', 'pending', 'revoked')).toBe(false);
      expect(await repository.findById(saved.id)).toEqual({ ...saved, status: 'accepted' });
    });

    it('keeps an unexpired pending invitation instead of replacing it', async () => {
      const pending = record({ expiresAt: 2_000 });
      expect(await repository.saveUnlessPending(pending, 1_000)).toBe(true);
      const rival = record({ email: pending.email, role: 'admin', createdAt: 1_500 });
      expect(await repository.saveUnlessPending(rival, 1_500)).toBe(false);
      expect(await repository.findByEmail(pending.email)).toEqual(pending);
      expect(await repository.findByTokenHash(rival.tokenHash)).toBeNull();
    });

    it('replaces a revoked, accepted or expired invitation for the same email', async () => {
      const revoked = record({ email: 'revoked@example.com', status: 'revoked' });
      const accepted = record({ email: 'accepted@example.com', status: 'accepted' });
      const expired = record({ email: 'expired@example.com', expiresAt: 2_000 });
      for (const previous of [revoked, accepted, expired]) {
        await repository.save(previous);
        const next = record({ email: previous.email, createdAt: 2_000, expiresAt: 9_000 });
        expect(await repository.saveUnlessPending(next, 2_000)).toBe(true);
        expect(await repository.findByEmail(previous.email)).toEqual(next);
      }
    });

    it('keeps the first of two back-to-back conditional saves for the same email', async () => {
      const first = record();
      const second = record({ email: first.email, role: 'admin' });
      expect(await repository.saveUnlessPending(first, 1_000)).toBe(true);
      expect(await repository.saveUnlessPending(second, 1_000)).toBe(false);
      expect(await repository.findByEmail(first.email)).toEqual(first);
    });
  });
}

describeRepository('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteFiles: string[] = [];

describeRepository('sqlite', async () => {
  const filepath = path.join(os.tmpdir(), `invitations-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const adapter = new SqliteAdapter({ filepath });
  await adapter.initialize();
  return adapter;
});

afterAll(() => {
  for (const filepath of sqliteFiles) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
});
