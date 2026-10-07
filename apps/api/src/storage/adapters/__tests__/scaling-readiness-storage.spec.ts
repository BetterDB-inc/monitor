import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import type {
  StoragePort,
  StoredScalingReadinessScore,
} from '../../../common/interfaces/storage-port.interface';

const row = (o: Partial<StoredScalingReadinessScore> = {}): StoredScalingReadinessScore => ({
  id: `r-${Math.random()}`,
  connectionId: 'conn-a',
  timestamp: 1_000,
  score: 55,
  band: 'yellow',
  bindingDimension: 'memory',
  dimensions: [
    { key: 'memory', score: 40, weight: 30, contribution: 15, detail: '80% of 1 GB', excludedReason: null },
  ],
  ...o,
});

describe.each([
  ['memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    return { storage: storage as StoragePort, cleanup: async () => storage.close() };
  }],
  ['sqlite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaling-readiness-'));
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
])('%s adapter scaling readiness storage', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });
  afterEach(async () => cleanup());

  it('stores and reads scores ascending within a range', async () => {
    await storage.saveScalingReadinessScore(row({ timestamp: 3_000, score: 70, band: 'green' }));
    await storage.saveScalingReadinessScore(row({ timestamp: 1_000 }));
    await storage.saveScalingReadinessScore(row({ timestamp: 2_000 }));
    await storage.saveScalingReadinessScore(row({ timestamp: 2_500, connectionId: 'conn-b' }));
    const rows = await storage.getScalingReadinessScores({ connectionId: 'conn-a', from: 1_500, to: 3_000 });
    expect(rows.map((r) => r.timestamp)).toEqual([2_000, 3_000]);
    expect(rows[1]).toMatchObject({ score: 70, band: 'green', bindingDimension: 'memory' });
    expect(rows[0].dimensions[0]).toMatchObject({ key: 'memory', detail: '80% of 1 GB' });
  });

  it('prunes rows older than the cutoff', async () => {
    await storage.saveScalingReadinessScore(row({ timestamp: 1_000 }));
    await storage.saveScalingReadinessScore(row({ timestamp: 5_000 }));
    expect(await storage.pruneOldScalingReadinessScores(2_000)).toBe(1);
    expect(await storage.getScalingReadinessScores({ connectionId: 'conn-a' })).toHaveLength(1);
  });

  it('upserts settings per connection', async () => {
    expect(await storage.getScalingReadinessSettings('conn-a')).toBeNull();
    await storage.saveScalingReadinessSettings({ connectionId: 'conn-a', alertEnabled: true, alertThreshold: 40, updatedAt: 1 });
    await storage.saveScalingReadinessSettings({ connectionId: 'conn-a', alertEnabled: false, alertThreshold: 55, updatedAt: 2 });
    expect(await storage.getScalingReadinessSettings('conn-a')).toEqual({
      connectionId: 'conn-a', alertEnabled: false, alertThreshold: 55, updatedAt: 2,
    });
  });
});
