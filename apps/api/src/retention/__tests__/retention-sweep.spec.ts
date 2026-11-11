import { Logger } from '@nestjs/common';
import type { StoredAclEntry } from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import {
  adapters,
  type AdapterFactory,
} from '../../storage/adapters/__tests__/anomaly-storage-adapters';
import { MS_PER_DAY } from '../retention-policy.service';
import { runRetentionSweep } from '../retention-sweep';
import { sweepFixtures } from './retention-sweep.fixture';

const NOW_MS = 1_700_000_000_500;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const SECONDS_PER_DAY = 24 * 60 * 60;
const RETENTION_DAYS = 30;
const CUTOFF_MS = NOW_MS - RETENTION_DAYS * MS_PER_DAY;
const CONNECTION_ID = 'conn-1';
const SEED_TIMES = { expiredAtMs: NOW_MS - 40 * MS_PER_DAY, recentAtMs: NOW_MS - MS_PER_DAY };
// MemoryAdapter keeps no key analytics: saving and reading them throws, and their prunes report 0.
const STORES_MEMORY_ADAPTER_DOES_NOT_KEEP = ['key_patterns', 'hot_keys'];

const aclEntry = (capturedAt: number): StoredAclEntry => ({
  id: 0,
  count: 1,
  reason: 'auth',
  context: 'toplevel',
  object: 'AUTH',
  username: 'app',
  ageSeconds: 1,
  clientInfo: 'id=1 addr=10.0.0.1:5000',
  timestampCreated: capturedAt,
  timestampLastUpdated: capturedAt,
  capturedAt,
  sourceHost: 'localhost',
  sourcePort: 6379,
});

describe.each<[string, AdapterFactory]>(adapters)('retention sweep (%s)', (name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;
  const logger = { error: jest.fn() } as unknown as Logger;

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
  });

  afterEach(async () => {
    await cleanup();
  });

  const capturedAtOfRemainingAclEntries = async () =>
    (await storage.getAclEntries({ connectionId: CONNECTION_ID })).map((entry) => entry.capturedAt);

  it('keeps ACL audit entries captured inside the retention window', async () => {
    const recent = NOW_SECONDS - SECONDS_PER_DAY;
    const expired = NOW_SECONDS - 40 * SECONDS_PER_DAY;
    await storage.saveAclEntries([aclEntry(recent), aclEntry(expired)], CONNECTION_ID);

    const results = await runRetentionSweep(storage, CUTOFF_MS, logger);

    expect(await capturedAtOfRemainingAclEntries()).toEqual([recent]);
    expect(results.acl_entries).toBe(1);
  });

  it('keeps an ACL audit entry captured in the second the cutoff falls in', async () => {
    const cutoffSecond = Math.floor(CUTOFF_MS / 1000);
    await storage.saveAclEntries(
      [aclEntry(cutoffSecond), aclEntry(cutoffSecond - 1)],
      CONNECTION_ID,
    );

    await runRetentionSweep(storage, CUTOFF_MS, logger);

    expect(await capturedAtOfRemainingAclEntries()).toEqual([cutoffSecond]);
  });

  const storesNotKept = name === 'MemoryAdapter' ? STORES_MEMORY_ADAPTER_DOES_NOT_KEEP : [];
  const storesKept = Object.keys(sweepFixtures).filter((store) => !storesNotKept.includes(store));

  it.each(storesKept)('prunes only expired rows from %s', async (store) => {
    const fixture = sweepFixtures[store];
    await fixture.seed(storage, SEED_TIMES);
    expect(await fixture.remaining(storage)).toBe(2);

    const results = await runRetentionSweep(storage, CUTOFF_MS, logger);

    expect(await fixture.remaining(storage)).toBe(1);
    expect(results[store]).toBe(1);
  });

  if (storesNotKept.length > 0) {
    it.each(storesNotKept)('has no %s rows to prune', async (store) => {
      await expect(sweepFixtures[store].seed(storage, SEED_TIMES)).rejects.toThrow(
        'not supported in memory adapter',
      );

      const results = await runRetentionSweep(storage, CUTOFF_MS, logger);

      expect(results[store]).toBe(0);
    });
  }

  it('has a fixture for every store the sweep prunes', async () => {
    const results = await runRetentionSweep(storage, CUTOFF_MS, logger);

    expect(Object.keys(results).sort()).toEqual(Object.keys(sweepFixtures).sort());
  });
});
