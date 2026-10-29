import type { StoredClientSnapshot } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';

function snapshot(addr: string): StoredClientSnapshot {
  return {
    id: 0,
    clientId: addr,
    addr,
    name: '',
    user: 'default',
    db: 0,
    cmd: 'get',
    age: 1,
    idle: 0,
    flags: 'N',
    sub: 0,
    psub: 0,
    qbuf: 0,
    qbufFree: 0,
    obl: 0,
    oll: 0,
    omem: 0,
    capturedAt: 1_700_000_000_000,
    sourceHost: 'localhost',
    sourcePort: 6379,
  };
}

describe('MemoryAdapter.getClientSnapshots addr filter', () => {
  let storage: MemoryAdapter;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.saveClientSnapshot(
      [snapshot('10.0.0.1:5000'), snapshot('10.0.0.2:5000'), snapshot('100x0x0x1:5000')],
      'conn-1',
    );
  });

  it('treats % as a wildcard', async () => {
    const rows = await storage.getClientSnapshots({ addr: '10.0.0.%' });
    expect(rows.map((row) => row.addr).sort()).toEqual(['10.0.0.1:5000', '10.0.0.2:5000']);
  });

  it('matches regex metacharacters literally', async () => {
    await expect(storage.getClientSnapshots({ addr: '%(' })).resolves.toEqual([]);
    await expect(storage.getClientSnapshots({ addr: '%(a+)+$' })).resolves.toEqual([]);
    await expect(storage.getClientSnapshots({ addr: '10.0.0.*%' })).resolves.toEqual([]);
  });

  it('keeps substring semantics around the wildcard', async () => {
    const rows = await storage.getClientSnapshots({ addr: '0.0.%:5' });
    expect(rows).toHaveLength(2);
    await expect(
      storage.getClientSnapshots({ addr: `${'%1'.repeat(40)}%!` }),
    ).resolves.toEqual([]);
  });
});
