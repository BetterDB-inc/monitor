import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteAdapter } from '../../storage/adapters/sqlite.adapter';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import { runNamespaceStorageContract } from './namespace-storage-contract';

describe.each([
  ['memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    return { storage: storage as StoragePort, cleanup: async () => storage.close() };
  }],
  ['sqlite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-namespaces-'));
    const storage = new SqliteAdapter({ filepath: path.join(dir, 'db.sqlite') });
    await storage.initialize();
    return {
      storage: storage as StoragePort,
      cleanup: async () => {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }],
])('%s adapter session namespace storage', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });
  afterEach(async () => cleanup());

  runNamespaceStorageContract(() => storage);
});

