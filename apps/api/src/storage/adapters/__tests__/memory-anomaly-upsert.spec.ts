import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../memory.adapter';
import type { StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

const event = (overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
  id: randomUUID(),
  timestamp: 1_000,
  metricType: 'connections',
  anomalyType: 'spike',
  severity: 'warning',
  value: 2,
  baseline: 1,
  stdDev: 0,
  zScore: 0,
  threshold: 1,
  message: 'spike',
  resolved: false,
  connectionId: 'conn-1',
  ...overrides,
});

describe('MemoryAdapter anomaly upsert', () => {
  let storage: MemoryAdapter;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  it('finds an existing event without scanning the list', async () => {
    const first = event();
    await storage.saveAnomalyEvent(first, 'conn-1');
    const scan = jest.spyOn((storage as any).anomalyEvents, 'findIndex');

    await storage.saveAnomalyEvent({ ...first, correlationId: 'group' }, 'conn-1');

    expect(scan).not.toHaveBeenCalled();
    expect(await storage.getAnomalyEvents()).toEqual([
      expect.objectContaining({ id: first.id, correlationId: 'group' }),
    ]);
  });

  it('merges a resolve into the stored event', async () => {
    const first = event();
    await storage.saveAnomalyEvent(first, 'conn-1');

    await storage.resolveAnomaly(first.id, 2_000);
    await storage.saveAnomalyEvent({ ...first, correlationId: 'group' }, 'conn-1');

    expect(await storage.getAnomalyEvents()).toEqual([
      expect.objectContaining({ resolved: true, resolvedAt: 2_000, correlationId: 'group' }),
    ]);
  });

  it('stores a pruned id as a new event', async () => {
    const first = event();
    await storage.saveAnomalyEvent(first, 'conn-1');
    await storage.pruneOldAnomalyEvents(2_000);

    await storage.saveAnomalyEvent(first, 'conn-1');

    expect(await storage.getAnomalyEvents()).toHaveLength(1);
    expect(await storage.resolveAnomaly(first.id, 3_000)).toBe(true);
  });

  it('keeps events of other connections when pruning one', async () => {
    const kept = event({ connectionId: 'conn-2' });
    await storage.saveAnomalyEvent(event(), 'conn-1');
    await storage.saveAnomalyEvent(kept, 'conn-2');

    await storage.pruneOldAnomalyEvents(2_000, 'conn-1');

    expect(await storage.resolveAnomaly(kept.id, 3_000)).toBe(true);
  });
});
