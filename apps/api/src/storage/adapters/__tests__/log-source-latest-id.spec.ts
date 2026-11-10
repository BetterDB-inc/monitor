import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import { assertLogSourceTracking } from './log-source-assertions';

describe('latest slow/command log id per source', () => {
  it('memory adapter', async () => {
    await assertLogSourceTracking(new MemoryAdapter());
  });

  it('sqlite adapter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-source-'));
    const adapter = new SqliteAdapter({ filepath: path.join(dir, 'audit.db') });
    try {
      await adapter.initialize();
      await assertLogSourceTracking(adapter);
    } finally {
      await adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
