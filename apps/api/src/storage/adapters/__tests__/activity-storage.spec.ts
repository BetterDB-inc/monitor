import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ActivityRecord,
  ActivityRepository,
} from '../../../common/interfaces/activity-repository.interface';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

function record(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: randomUUID(),
    occurredAt: 1_000,
    actorUserId: 'owner-id',
    actorEmail: 'owner@example.com',
    actorVia: 'session',
    tokenId: null,
    action: 'connection.create',
    targetType: 'connection',
    targetId: 'conn-1',
    connectionId: 'conn-1',
    statusCode: 201,
    ip: '127.0.0.1',
    details: { method: 'POST', path: '/connections' },
    ...overrides,
  };
}

function describeRepository(name: string, open: () => Promise<StoragePort>): void {
  describe(`ActivityRepository (${name})`, () => {
    let storage: StoragePort;
    let repository: ActivityRepository;

    beforeEach(async () => {
      storage = await open();
      repository = storage.getActivityRepository();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('round-trips a record including the details JSON', async () => {
      const saved = record({ tokenId: 'tok-1', details: { command: 'GET', argCount: 1 } });
      await repository.insert(saved);
      const page = await repository.list({ limit: 10 });
      expect(page.items).toEqual([saved]);
      expect(page.next).toBeNull();
    });

    it('lists newest first with id as the tie-breaker', async () => {
      await repository.insert(record({ id: 'a', occurredAt: 10 }));
      await repository.insert(record({ id: 'c', occurredAt: 30 }));
      await repository.insert(record({ id: 'b', occurredAt: 30 }));
      const ids = (await repository.list({ limit: 10 })).items.map((item) => {
        return item.id;
      });
      expect(ids).toEqual(['c', 'b', 'a']);
    });

    it('pages with a keyset cursor and reports the next cursor only when more rows exist', async () => {
      await repository.insert(record({ id: 'a', occurredAt: 10 }));
      await repository.insert(record({ id: 'b', occurredAt: 20 }));
      await repository.insert(record({ id: 'c', occurredAt: 30 }));
      const first = await repository.list({ limit: 2 });
      expect(
        first.items.map((item) => {
          return item.id;
        }),
      ).toEqual(['c', 'b']);
      expect(first.next).toEqual({ occurredAt: 20, id: 'b' });
      const second = await repository.list({ limit: 2, before: first.next ?? undefined });
      expect(
        second.items.map((item) => {
          return item.id;
        }),
      ).toEqual(['a']);
      expect(second.next).toBeNull();
    });

    it('filters by actor, action and an inclusive time window', async () => {
      await repository.insert(record({ id: 'a', occurredAt: 10, actorUserId: 'u1' }));
      await repository.insert(
        record({ id: 'b', occurredAt: 20, actorUserId: 'u2', action: 'member.invite' }),
      );
      await repository.insert(record({ id: 'c', occurredAt: 30, actorUserId: 'u1' }));
      const byActor = await repository.list({ limit: 10, actorUserId: 'u1' });
      expect(
        byActor.items.map((item) => {
          return item.id;
        }),
      ).toEqual(['c', 'a']);
      const byAction = await repository.list({ limit: 10, action: 'member.invite' });
      expect(
        byAction.items.map((item) => {
          return item.id;
        }),
      ).toEqual(['b']);
      const window = await repository.list({ limit: 10, from: 20, to: 30 });
      expect(
        window.items.map((item) => {
          return item.id;
        }),
      ).toEqual(['c', 'b']);
    });

    it('prunes rows older than the boundary and returns the count', async () => {
      await repository.insert(record({ id: 'old', occurredAt: 10 }));
      await repository.insert(record({ id: 'edge', occurredAt: 20 }));
      await repository.insert(record({ id: 'new', occurredAt: 30 }));
      expect(await repository.prune(20)).toBe(1);
      const ids = (await repository.list({ limit: 10 })).items.map((item) => {
        return item.id;
      });
      expect(ids).toEqual(['new', 'edge']);
    });
  });
}

describeRepository('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteDirs: string[] = [];

describeRepository('sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-storage-'));
  sqliteDirs.push(dir);
  const adapter = new SqliteAdapter({ filepath: path.join(dir, 'test.db') });
  await adapter.initialize();
  return adapter;
});

afterAll(() => {
  for (const dir of sqliteDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
