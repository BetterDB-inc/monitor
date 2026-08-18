import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoredAclEntry } from '../../../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-acl';
const CREATED_AT = 1_700_000_000;

function aclEntry(overrides: Partial<StoredAclEntry> = {}): StoredAclEntry {
  return {
    id: 0,
    count: 3,
    reason: 'auth',
    context: 'toplevel',
    object: 'AUTH',
    username: 'default',
    ageSeconds: 5,
    clientInfo: 'addr=10.0.0.1:53124 laddr=10.0.0.9:6379 name=',
    timestampCreated: CREATED_AT,
    timestampLastUpdated: CREATED_AT,
    capturedAt: CREATED_AT * 1000,
    sourceHost: 'localhost',
    sourcePort: 6379,
    ...overrides,
  };
}

describe('ACL audit upsert refreshes client_info', () => {
  describe('MemoryAdapter', () => {
    let storage: MemoryAdapter;

    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.initialize();
    });

    it('carries the newest client_info onto an existing entry', async () => {
      await storage.saveAclEntries([aclEntry()], CONNECTION_ID);
      await storage.saveAclEntries(
        [
          aclEntry({
            count: 9,
            clientInfo: 'addr=10.0.0.2:41022 laddr=10.0.0.9:6379 name=',
          }),
        ],
        CONNECTION_ID,
      );

      const rows = await storage.getAclEntries({ connectionId: CONNECTION_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(9);
      expect(rows[0].clientInfo).toContain('addr=10.0.0.2:41022');
    });
  });

  describe('SqliteAdapter', () => {
    let storage: SqliteAdapter;
    let dbPath: string;

    beforeEach(async () => {
      dbPath = path.join(os.tmpdir(), `acl-client-info-${randomUUID()}.db`);
      storage = new SqliteAdapter({ filepath: dbPath });
      await storage.initialize();
    });

    afterEach(async () => {
      await storage.close();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    it('carries the newest client_info onto an existing entry', async () => {
      await storage.saveAclEntries([aclEntry()], CONNECTION_ID);
      await storage.saveAclEntries(
        [
          aclEntry({
            count: 9,
            clientInfo: 'addr=10.0.0.2:41022 laddr=10.0.0.9:6379 name=',
          }),
        ],
        CONNECTION_ID,
      );

      const rows = await storage.getAclEntries({ connectionId: CONNECTION_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(9);
      expect(rows[0].clientInfo).toContain('addr=10.0.0.2:41022');
    });
  });
});
