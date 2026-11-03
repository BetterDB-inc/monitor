import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

// Slow/command log IDs are per node. A connection whose host fronts several
// nodes must be able to resume each node from that node's own last ID.
const slow = (id: number, host: string) => ({
  id, timestamp: 1_700_000_000 + id, duration: 10_000, command: ['EVAL'], clientAddress: '', clientName: '',
  capturedAt: 1, sourceHost: host, sourcePort: 6379, connectionId: 'seed',
});
const cmd = (id: number, host: string) => ({ ...slow(id, host), type: 'slow' as const });

async function exercise(storage: StoragePort): Promise<void> {
  await storage.saveSlowLogEntries([slow(40, '10.0.0.1'), slow(7, '10.0.0.2')], 'seed');
  await storage.saveCommandLogEntries([cmd(40, '10.0.0.1'), cmd(7, '10.0.0.2')], 'seed');

  expect(await storage.getLatestSlowLogId('seed')).toBe(40);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.2', port: 6379 })).toBe(7);
  expect(await storage.getLatestSlowLogId('seed', { host: '10.0.0.3', port: 6379 })).toBeNull();
  expect(await storage.getLatestCommandLogId('slow', 'seed')).toBe(40);
  expect(await storage.getLatestCommandLogId('slow', 'seed', { host: '10.0.0.2', port: 6379 })).toBe(7);
  expect(await storage.getLatestCommandLogId('slow', 'seed', { host: '10.0.0.2', port: 6380 })).toBeNull();
}

describe('latest slow/command log id per source', () => {
  it('memory adapter', async () => {
    await exercise(new MemoryAdapter());
  });

  it('sqlite adapter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-source-'));
    const adapter = new SqliteAdapter({ filepath: path.join(dir, 'audit.db') });
    try {
      await adapter.initialize();
      await exercise(adapter);
    } finally {
      await adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
