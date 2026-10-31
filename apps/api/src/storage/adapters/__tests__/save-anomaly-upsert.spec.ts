import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredAnomalyEvent,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'anomaly event upsert (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const CONN = 'conn-a';
    const ID = randomUUID();
    const CORRELATION_ID = randomUUID();

    const event = (overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
      id: ID,
      timestamp: 1_700_000_000_000,
      metricType: 'command_p99',
      anomalyType: 'spike',
      severity: 'warning',
      value: 900,
      baseline: 300,
      stdDev: 0,
      zScore: 0,
      threshold: 3,
      message: 'P99 regression',
      resolved: false,
      ...overrides,
    });

    const correlated = event({
      correlationId: CORRELATION_ID,
      relatedMetrics: ['cluster_state'],
    });
    const preserved = expect.objectContaining({
      correlationId: CORRELATION_ID,
      relatedMetrics: ['cluster_state'],
    });

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('stores the replica address', async () => {
      await storage.saveAnomalyEvent(event({ replicaAddr: '10.0.0.2:6379' }), CONN);
      await storage.saveAnomalyEvents([event({ id: randomUUID(), replicaAddr: '10.0.0.3:6379' })], CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows.map((r) => r.replicaAddr).sort()).toEqual(['10.0.0.2:6379', '10.0.0.3:6379']);
    });

    it('keeps the replica address when a later save omits it', async () => {
      await storage.saveAnomalyEvent(event({ replicaAddr: '10.0.0.2:6379' }), CONN);
      await storage.saveAnomalyEvent(correlated, CONN);

      const [row] = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(row.replicaAddr).toBe('10.0.0.2:6379');
    });

    it('keeps one row when the same event is saved again with a correlation id', async () => {
      await storage.saveAnomalyEvent(event(), CONN);
      await storage.saveAnomalyEvent({ ...correlated, message: 'changed' }, CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          correlationId: CORRELATION_ID,
          relatedMetrics: ['cluster_state'],
          message: 'P99 regression',
        }),
      );
    });

    it('keeps correlation fields when saved again without them', async () => {
      await storage.saveAnomalyEvent(correlated, CONN);
      await storage.saveAnomalyEvent(event(), CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(preserved);
    });

    it('adds correlation fields when batch saved again with them', async () => {
      await storage.saveAnomalyEvents([event()], CONN);
      await storage.saveAnomalyEvents([correlated], CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(preserved);
    });

    it('keeps correlation fields when batch saved again without them', async () => {
      await storage.saveAnomalyEvents([correlated], CONN);
      await storage.saveAnomalyEvents([event()], CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(preserved);
    });

    it('keeps an event resolved when a stale copy is saved again', async () => {
      await storage.saveAnomalyEvent(event(), CONN);
      await storage.resolveOpenAnomaly(ID, 1_700_000_060_000);

      await storage.saveAnomalyEvent(correlated, CONN);

      const [row] = await storage.getAnomalyEvents({ connectionId: CONN });
      expect(row).toEqual(
        expect.objectContaining({
          resolved: true,
          resolvedAt: 1_700_000_060_000,
          durationMs: 60_000,
          correlationId: CORRELATION_ID,
        }),
      );
    });

    it('keeps an event resolved when a stale copy is batch saved again', async () => {
      await storage.saveAnomalyEvent(event(), CONN);
      await storage.resolveOpenAnomaly(ID, 1_700_000_060_000);

      await storage.saveAnomalyEvents([correlated], CONN);

      const [row] = await storage.getAnomalyEvents({ connectionId: CONN });
      expect(row).toEqual(
        expect.objectContaining({ resolved: true, resolvedAt: 1_700_000_060_000 }),
      );
    });

    it('still records a resolution arriving through a save', async () => {
      await storage.saveAnomalyEvent(event(), CONN);

      await storage.saveAnomalyEvent(
        event({ resolved: true, resolvedAt: 1_700_000_060_000, durationMs: 60_000 }),
        CONN,
      );

      const [row] = await storage.getAnomalyEvents({ connectionId: CONN });
      expect(row).toEqual(
        expect.objectContaining({ resolved: true, resolvedAt: 1_700_000_060_000 }),
      );
    });

    it('filters by correlation id before the page limit', async () => {
      const other = randomUUID();
      await storage.saveAnomalyEvents(
        Array.from({ length: 120 }, (_, i) =>
          event({
            id: randomUUID(),
            timestamp: 1_700_000_000_000 + i,
            correlationId: i < 2 ? CORRELATION_ID : other,
          }),
        ),
        CONN,
      );

      const rows = await storage.getAnomalyEvents({
        connectionId: CONN,
        correlationIds: [CORRELATION_ID],
      });

      expect(rows).toHaveLength(2);
      expect(await storage.getAnomalyEvents({ connectionId: CONN, correlationIds: [] })).toEqual([]);
    });
  },
);
