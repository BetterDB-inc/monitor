import { ConflictException } from '@nestjs/common';
import { StoredAnomalyEvent } from '../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import {
  CaptureTriggerRegistry,
  DEFAULT_TRIGGER_EXPIRY_MS,
} from '../capture-trigger-registry';
import type { HealthGateService } from '../health-gate.service';
import type { MonitorCaptureService } from '../monitor-capture.service';

const CONNECTION_ID = 'conn-1';
const METRIC = 'connections';
const ANOMALY = 'spike';

interface FakeCaptureService {
  startSession: jest.Mock;
  hasActiveSessionOn: jest.Mock;
}

function makeCaptureService(opts: {
  active?: boolean;
  throwOnStart?: Error;
  sessionId?: string;
} = {}): FakeCaptureService {
  return {
    startSession: jest.fn().mockImplementation(async () => {
      if (opts.throwOnStart) {
        throw opts.throwOnStart;
      }
      return { id: opts.sessionId ?? 'sess-1', status: 'running' };
    }),
    hasActiveSessionOn: jest.fn().mockReturnValue(opts.active ?? false),
  };
}

interface FakeHealthGate {
  evaluate: jest.Mock;
}

function makeHealthGate(allow: boolean, skipReason?: string): FakeHealthGate {
  return {
    evaluate: jest.fn().mockResolvedValue({
      allow,
      skipReason: allow ? undefined : skipReason ?? 'memory_above_threshold',
      signals: {},
      thresholds: {},
    }),
  };
}

function makeRegistry(
  captureService: FakeCaptureService,
  healthGate: FakeHealthGate,
): { registry: CaptureTriggerRegistry; storage: MemoryAdapter } {
  const storage = new MemoryAdapter();
  const registry = new CaptureTriggerRegistry(
    storage,
    captureService as unknown as MonitorCaptureService,
    healthGate as unknown as HealthGateService,
  );
  registry.setOptions({ autoStart: false });
  // Tests want to see all stored anomaly events; the constructor seeds the
  // watermark to Date.now() to avoid replaying history on real restarts.
  registry.resetAnomalyWatermark();
  return { registry, storage };
}

function makeAnomaly(overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent {
  return {
    id: overrides.id ?? `evt-${Math.random()}`,
    timestamp: overrides.timestamp ?? Date.now(),
    metricType: overrides.metricType ?? METRIC,
    anomalyType: overrides.anomalyType ?? ANOMALY,
    severity: overrides.severity ?? 'high',
    value: overrides.value ?? 100,
    baseline: overrides.baseline ?? 10,
    stdDev: overrides.stdDev ?? 5,
    zScore: overrides.zScore ?? 10,
    threshold: overrides.threshold ?? 3,
    message: overrides.message ?? 'spike',
    resolved: overrides.resolved ?? false,
    connectionId: overrides.connectionId ?? CONNECTION_ID,
  };
}

describe('CaptureTriggerRegistry', () => {
  describe('createTrigger', () => {
    it('persists a configured trigger with a 24h default expiry', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const before = Date.now();
      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const after = Date.now();

      expect(trigger.status).toBe('configured');
      expect(trigger.connectionId).toBe(CONNECTION_ID);
      expect(trigger.metricType).toBe(METRIC);
      expect(trigger.anomalyType).toBe(ANOMALY);
      expect(trigger.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TRIGGER_EXPIRY_MS);
      expect(trigger.expiresAt).toBeLessThanOrEqual(after + DEFAULT_TRIGGER_EXPIRY_MS);

      const persisted = await storage.getCaptureTrigger(trigger.id);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('configured');
    });

    it('rejects a duplicate trigger for the same connection/metric/anomaly', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await expect(
        registry.createTrigger({
          connectionId: CONNECTION_ID,
          metricType: METRIC,
          anomalyType: ANOMALY,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows distinct anomaly types on the same metric', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry } = makeRegistry(captureService, healthGate);

      const spike = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: 'spike',
      });
      const drop = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: 'drop',
      });
      expect(spike.id).not.toBe(drop.id);
    });
  });

  describe('cancelTrigger', () => {
    it('marks a configured trigger as cancelled', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const ok = await registry.cancelTrigger(trigger.id);
      expect(ok).toBe(true);
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('cancelled');
    });

    it('returns false for already-fired triggers (no state transition)', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.updateCaptureTrigger(trigger.id, { status: 'fired' });
      const ok = await registry.cancelTrigger(trigger.id);
      expect(ok).toBe(false);
    });

    it('returns false for unknown ids', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry } = makeRegistry(captureService, healthGate);
      const ok = await registry.cancelTrigger('does-not-exist');
      expect(ok).toBe(false);
    });
  });

  describe('tick - anomaly matching', () => {
    it('fires a configured trigger when a matching anomaly arrives', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);

      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: CONNECTION_ID,
          source: 'trigger',
          triggerId: trigger.id,
        }),
      );
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('fired');
      expect(updated?.firedSessionId).toBe('sess-1');
      expect(updated?.firedAt).toBeGreaterThan(0);
    });

    it('only fires a trigger once for repeated matching anomalies', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const t = Date.now();
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: t + 1 }), CONNECTION_ID);
      await registry.tick();

      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: t + 2 }), CONNECTION_ID);
      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('ignores anomalies whose metric/anomaly type does not match', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: 'connections',
        anomalyType: 'spike',
      });
      await storage.saveAnomalyEvent(
        makeAnomaly({ metricType: 'memory_used', anomalyType: 'spike' }),
        CONNECTION_ID,
      );
      await registry.tick();
      expect(captureService.startSession).not.toHaveBeenCalled();
    });

    it('ignores anomalies on a different connection', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly({ connectionId: 'conn-other' }), 'conn-other');
      await registry.tick();
      expect(captureService.startSession).not.toHaveBeenCalled();
    });
  });

  describe('tick - health gate skip', () => {
    it('marks the trigger as skipped when the health gate blocks the fire', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(false, 'memory_above_threshold');
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();

      expect(captureService.startSession).not.toHaveBeenCalled();
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('skipped');
      expect(updated?.skipReason).toBe('memory_above_threshold');
    });
  });

  describe('tick - queue when busy', () => {
    it('queues the trigger when a session is already active on the connection', async () => {
      const captureService = makeCaptureService({ active: true });
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();

      expect(captureService.startSession).not.toHaveBeenCalled();
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('queued');
    });

    it('fires a queued trigger on a later tick after the session frees up', async () => {
      const captureService = makeCaptureService({ active: true });
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();
      expect((await storage.getCaptureTrigger(trigger.id))?.status).toBe('queued');

      captureService.hasActiveSessionOn.mockReturnValue(false);
      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('fired');
    });
  });

  describe('tick - expiry', () => {
    it('marks expired triggers as expired and does not fire them', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
        expiresAt: Date.now() - 1000,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();

      expect(captureService.startSession).not.toHaveBeenCalled();
      const updated = await storage.getCaptureTrigger(trigger.id);
      expect(updated?.status).toBe('expired');
    });
  });

  describe('tick - concurrency', () => {
    it('queues a second matching trigger when the first fire occupies the connection', async () => {
      const startCalls: Array<{ resolve: () => void; promise: Promise<unknown> }> = [];
      const captureService: FakeCaptureService = {
        startSession: jest.fn().mockImplementation(() => {
          let resolveFn: () => void;
          const promise = new Promise<unknown>((resolve) => {
            resolveFn = () => resolve({ id: `sess-${startCalls.length}`, status: 'running' });
          });
          startCalls.push({ resolve: resolveFn!, promise });
          return promise;
        }),
        hasActiveSessionOn: jest.fn().mockReturnValue(false),
      };
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: 'connections',
        anomalyType: 'spike',
      });
      await storage.saveAnomalyEvent(
        makeAnomaly({ metricType: 'connections', anomalyType: 'spike', timestamp: Date.now() + 1 }),
        CONNECTION_ID,
      );

      const firstTick = registry.tick();
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      expect(startCalls.length).toBe(1);
      startCalls[0].resolve();
      await firstTick;
      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });
  });
});
