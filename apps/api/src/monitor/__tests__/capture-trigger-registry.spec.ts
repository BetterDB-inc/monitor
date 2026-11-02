import { ConflictException, NotFoundException } from '@nestjs/common';
import { WebhookEventType } from '@betterdb/shared';
import { StoredAnomalyEvent } from '../../common/interfaces/storage-port.interface';
import { AnomalySavedBus } from '../../common/services/anomaly-saved-bus';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import type { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import {
  CaptureTriggerRegistry,
  DEFAULT_TRIGGER_EXPIRY_MS,
  MAX_PENDING_ANOMALIES,
  PENDING_ANOMALY_MAX_AGE_MS,
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

interface FakeDispatcher {
  dispatchEvent: jest.Mock;
  calls: Array<{ event: WebhookEventType; data: Record<string, unknown>; connectionId?: string }>;
}

function makeDispatcher(): FakeDispatcher {
  const fake: FakeDispatcher = {
    dispatchEvent: jest.fn(),
    calls: [],
  };
  fake.dispatchEvent.mockImplementation(async (event, data, connectionId) => {
    fake.calls.push({ event, data, connectionId });
  });
  return fake;
}

function makeRegistry(
  captureService: FakeCaptureService,
  healthGate: FakeHealthGate,
  dispatcher: FakeDispatcher = makeDispatcher(),
): {
  registry: CaptureTriggerRegistry;
  storage: MemoryAdapter;
  dispatcher: FakeDispatcher;
} {
  const storage = new MemoryAdapter();
  const bus = new AnomalySavedBus();
  const save = storage.saveAnomalyEvent.bind(storage);
  storage.saveAnomalyEvent = async (event, connectionId) => {
    const id = await save(event, connectionId);
    bus.publish({ ...event, connectionId });
    return id;
  };
  const registry = new CaptureTriggerRegistry(
    storage,
    captureService as unknown as MonitorCaptureService,
    healthGate as unknown as HealthGateService,
    dispatcher as unknown as WebhookDispatcherService,
    bus,
  );
  registry.setOptions({ autoStart: false });
  return { registry, storage, dispatcher };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
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

    it('matches an event again after a tick failed on it', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      healthGate.evaluate.mockRejectedValueOnce(new Error('storage down'));
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: Date.now() + 1 }), CONNECTION_ID);

      await registry.tick();
      expect(captureService.startSession).not.toHaveBeenCalled();
      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('reaches later events past one that keeps failing', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);
      healthGate.evaluate.mockImplementation(async (connectionId: string) => {
        if (connectionId === 'removed') throw new Error('Connection not found');
        return { allow: true, signals: {}, thresholds: {} };
      });
      const timestamp = Date.now() + 1;
      await registry.createTrigger({ connectionId: 'removed', metricType: METRIC, anomalyType: ANOMALY });
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp }), 'removed');
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: timestamp + 1 }), CONNECTION_ID);

      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
      expect(captureService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: CONNECTION_ID }),
      );
    });

    it('reaches new events past a queued trigger that keeps failing', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);
      healthGate.evaluate.mockImplementation(async (connectionId: string) => {
        if (connectionId === 'removed') throw new Error('Connection not found');
        return { allow: true, signals: {}, thresholds: {} };
      });
      const queued = await registry.createTrigger({
        connectionId: 'removed',
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.updateCaptureTrigger(queued.id, { status: 'queued' });
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: Date.now() + 1 }), CONNECTION_ID);

      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('fires for an event saved late with an older timestamp', async () => {
      const captureService = makeCaptureService();
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      const createdAt = Date.now();
      await storage.saveAnomalyEvent(
        makeAnomaly({ metricType: 'other', timestamp: createdAt + 60_000 }),
        CONNECTION_ID,
      );
      await registry.tick();
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });

      await storage.saveAnomalyEvent(
        makeAnomaly({ timestamp: createdAt + 30_000 }),
        CONNECTION_ID,
      );
      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('fires for an event the outbox saved nearly an hour after it happened', async () => {
      const captureService = makeCaptureService();
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 59 * 60_000);

      await storage.saveAnomalyEvent(
        makeAnomaly({ timestamp: trigger.createdAt + 1 }),
        CONNECTION_ID,
      );
      await registry.tick();
      clock.mockRestore();

      expect((await registry.getTrigger(trigger.id))?.status).toBe('fired');
    });

    it('reads no anomalies from storage while nothing new was saved', async () => {
      const { registry, storage } = makeRegistry(makeCaptureService(), makeHealthGate(true));
      const read = jest.spyOn(storage, 'getAnomalyEvents');

      await registry.tick();

      expect(read).not.toHaveBeenCalled();
    });

    it('gives up on an event that keeps failing once it is too old', async () => {
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(makeCaptureService(), healthGate);
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      jest.spyOn(storage, 'updateCaptureTrigger').mockRejectedValue(new Error('storage down'));
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: Date.now() + 1 }), CONNECTION_ID);
      await expect(registry.tick()).rejects.toThrow('storage down');
      expect(healthGate.evaluate).toHaveBeenCalledTimes(1);

      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + PENDING_ANOMALY_MAX_AGE_MS + 1);
      await registry.tick();
      clock.mockRestore();

      expect(healthGate.evaluate).toHaveBeenCalledTimes(1);
    });

    it('holds a bounded number of unmatched events', async () => {
      const captureService = makeCaptureService();
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const timestamp = Date.now() + 1;
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp }), CONNECTION_ID);
      for (let i = 0; i < MAX_PENDING_ANOMALIES; i++) {
        await storage.saveAnomalyEvent(
          makeAnomaly({ metricType: 'memory_used', timestamp }),
          CONNECTION_ID,
        );
      }

      await registry.tick();

      expect(captureService.startSession).not.toHaveBeenCalled();
    });

    it('handles each event once across ticks', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);
      const event = makeAnomaly({ timestamp: Date.now() + 60_000 });
      await storage.saveAnomalyEvent(event, CONNECTION_ID);
      await registry.tick();
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });

      await registry.tick();

      expect(captureService.startSession).not.toHaveBeenCalled();
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
    it('queues the trigger when a session starts during the health gate', async () => {
      const captureService = makeCaptureService({
        throwOnStart: new ConflictException('connection busy'),
      });
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: Date.now() + 1 }), CONNECTION_ID);

      await registry.tick();

      expect((await storage.getCaptureTrigger(trigger.id))?.status).toBe('queued');
    });

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

    it('queues without running the health gate while a session is active', async () => {
      const captureService = makeCaptureService({ active: true });
      const healthGate = makeHealthGate(false, 'memory_above_threshold');
      const { registry, storage } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();

      expect(healthGate.evaluate).not.toHaveBeenCalled();
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

  describe('webhook dispatch', () => {
    it('dispatches monitor.trigger.created after a successful createTrigger', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, dispatcher } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
        createdBy: 'alice',
      });
      await flushMicrotasks();

      expect(dispatcher.dispatchEvent).toHaveBeenCalledWith(
        WebhookEventType.MONITOR_TRIGGER_CREATED,
        expect.objectContaining({
          triggerId: trigger.id,
          metricType: METRIC,
          anomalyType: ANOMALY,
          createdBy: 'alice',
        }),
        CONNECTION_ID,
      );
    });

    it('dispatches monitor.session.skipped with the gate skip reason', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(false, 'memory_above_threshold');
      const { registry, storage, dispatcher } = makeRegistry(captureService, healthGate);

      const trigger = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();
      await flushMicrotasks();

      expect(dispatcher.dispatchEvent).toHaveBeenCalledWith(
        WebhookEventType.MONITOR_SESSION_SKIPPED,
        expect.objectContaining({
          triggerId: trigger.id,
          metricType: METRIC,
          anomalyType: ANOMALY,
          reason: 'memory_above_threshold',
        }),
        CONNECTION_ID,
      );
    });

    it('does not dispatch monitor.session.skipped on successful fire', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage, dispatcher } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();
      await flushMicrotasks();

      const skipped = dispatcher.calls.filter((c) => {
        return c.event === WebhookEventType.MONITOR_SESSION_SKIPPED;
      });
      expect(skipped).toHaveLength(0);
    });

    it('does not dispatch monitor.session.skipped when the trigger is queued (not skipped)', async () => {
      const captureService = makeCaptureService({ active: true });
      const healthGate = makeHealthGate(true);
      const { registry, storage, dispatcher } = makeRegistry(captureService, healthGate);

      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      await storage.saveAnomalyEvent(makeAnomaly(), CONNECTION_ID);
      await registry.tick();
      await flushMicrotasks();

      const skipped = dispatcher.calls.filter((c) => {
        return c.event === WebhookEventType.MONITOR_SESSION_SKIPPED;
      });
      expect(skipped).toHaveLength(0);
    });

    it('swallows webhook dispatcher errors so the registry remains operational', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const dispatcher = makeDispatcher();
      dispatcher.dispatchEvent.mockRejectedValueOnce(new Error('webhook unreachable'));
      const { registry } = makeRegistry(captureService, healthGate, dispatcher);

      await expect(
        registry.createTrigger({
          connectionId: CONNECTION_ID,
          metricType: METRIC,
          anomalyType: ANOMALY,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('tick - concurrency', () => {
    async function createFiringTrigger(
      registry: CaptureTriggerRegistry,
      storage: MemoryAdapter,
      connectionId: string,
      metricType: string,
    ): Promise<void> {
      await registry.createTrigger({ connectionId, metricType, anomalyType: ANOMALY });
      await storage.saveAnomalyEvent(
        makeAnomaly({ connectionId, metricType, timestamp: Date.now() + 1 }),
        connectionId,
      );
    }

    async function settle(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
    }

    it('evaluates the health gates of different connections at the same time', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const finishGates: Array<(value: unknown) => void> = [];
      healthGate.evaluate.mockImplementation(
        () => new Promise((resolve) => finishGates.push(resolve)),
      );
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, 'conn-1', METRIC);
      await createFiringTrigger(registry, storage, 'conn-2', METRIC);
      await createFiringTrigger(registry, storage, 'conn-3', METRIC);

      const tick = registry.tick();
      await settle();

      expect(healthGate.evaluate).toHaveBeenCalledTimes(3);
      for (const finishGate of finishGates) {
        finishGate({ allow: true, signals: {}, thresholds: {} });
      }
      await tick;
      expect(captureService.startSession).toHaveBeenCalledTimes(3);
    });

    it('leaves sharing a reading to the gate', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(false, 'replication_lag_elevated');
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'connections');
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'memory_used');
      const queued = await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: 'ops',
        anomalyType: ANOMALY,
      });
      await storage.updateCaptureTrigger(queued.id, { status: 'queued' });

      await registry.tick();

      expect(healthGate.evaluate).toHaveBeenCalledTimes(3);
      const triggers = await registry.listTriggers({ connectionId: CONNECTION_ID });
      expect(triggers.map((t) => t.status)).toEqual(['skipped', 'skipped', 'skipped']);
    });

    it('evaluates again after a session ran on the connection', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(false, 'replication_lag_elevated');
      healthGate.evaluate.mockResolvedValueOnce({ allow: true, signals: {}, thresholds: {} });
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'connections');
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'memory_used');

      await registry.tick();

      expect(healthGate.evaluate).toHaveBeenCalledTimes(2);
      expect(captureService.startSession).toHaveBeenCalledTimes(1);
      const triggers = await registry.listTriggers({ connectionId: CONNECTION_ID });
      expect(triggers.map((t) => t.status).sort()).toEqual(['fired', 'skipped']);
    });

    describe('a trigger that changes while the tick runs', () => {
      const allow = { allow: true, signals: {}, thresholds: {} };
      const deny = { allow: false, skipReason: 'memory_above_threshold', signals: {}, thresholds: {} };

      async function firingTrigger(registry: CaptureTriggerRegistry, storage: MemoryAdapter) {
        await createFiringTrigger(registry, storage, CONNECTION_ID, METRIC);
        const [trigger] = await registry.listTriggers({ connectionId: CONNECTION_ID });
        return trigger;
      }

      it('does not fire one cancelled during the health gate', async () => {
        const captureService = makeCaptureService();
        const healthGate = makeHealthGate(true);
        const { registry, storage } = makeRegistry(captureService, healthGate);
        const trigger = await firingTrigger(registry, storage);
        healthGate.evaluate.mockImplementation(async () => {
          await registry.cancelTrigger(trigger.id);
          return allow;
        });

        await registry.tick();

        expect(captureService.startSession).not.toHaveBeenCalled();
        expect((await registry.getTrigger(trigger.id))?.status).toBe('cancelled');
      });

      it('does not report one cancelled during a blocking health gate as skipped', async () => {
        const captureService = makeCaptureService();
        const healthGate = makeHealthGate(false);
        const dispatcher = makeDispatcher();
        const { registry, storage } = makeRegistry(captureService, healthGate, dispatcher);
        const trigger = await firingTrigger(registry, storage);
        healthGate.evaluate.mockImplementation(async () => {
          await registry.cancelTrigger(trigger.id);
          return deny;
        });

        await registry.tick();
        await settle();

        expect((await registry.getTrigger(trigger.id))?.status).toBe('cancelled');
        expect(dispatcher.calls.map((c) => c.event)).not.toContain(
          WebhookEventType.MONITOR_SESSION_SKIPPED,
        );
      });

      it('does not fire one that expires during the health gate', async () => {
        const captureService = makeCaptureService();
        const healthGate = makeHealthGate(true);
        const { registry, storage } = makeRegistry(captureService, healthGate);
        await registry.createTrigger({
          connectionId: CONNECTION_ID,
          metricType: METRIC,
          anomalyType: ANOMALY,
          expiresAt: Date.now() + 30,
        });
        await storage.saveAnomalyEvent(
          makeAnomaly({ metricType: METRIC, timestamp: Date.now() + 1 }),
          CONNECTION_ID,
        );
        healthGate.evaluate.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return allow;
        });

        await registry.tick();

        expect(captureService.startSession).not.toHaveBeenCalled();
      });

      it('keeps a cancel that lands after the status was read', async () => {
        const captureService = makeCaptureService();
        const healthGate = makeHealthGate(false);
        const dispatcher = makeDispatcher();
        const { registry, storage } = makeRegistry(captureService, healthGate, dispatcher);
        const trigger = await firingTrigger(registry, storage);
        const update = storage.updateCaptureTrigger.bind(storage);
        jest.spyOn(storage, 'updateCaptureTrigger').mockImplementationOnce(async (...args) => {
          await update(trigger.id, { status: 'cancelled' });
          return update(...args);
        });

        await registry.tick();
        await settle();

        expect((await registry.getTrigger(trigger.id))?.status).toBe('cancelled');
        expect(dispatcher.calls.map((c) => c.event)).not.toContain(
          WebhookEventType.MONITOR_SESSION_SKIPPED,
        );
      });

      it('cannot be cancelled once the fire has claimed it', async () => {
        const captureService = makeCaptureService();
        const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
        const trigger = await firingTrigger(registry, storage);
        let cancelled: boolean | undefined;
        captureService.startSession.mockImplementation(async () => {
          cancelled = await registry.cancelTrigger(trigger.id);
          return { id: 'sess-1', status: 'running' };
        });

        await registry.tick();

        expect(cancelled).toBe(false);
        expect(await registry.getTrigger(trigger.id)).toMatchObject({
          status: 'fired',
          firedSessionId: 'sess-1',
        });
      });

      it('records no fire time for a start that failed', async () => {
        const captureService = makeCaptureService({ throwOnStart: new Error('boom') });
        const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
        const trigger = await firingTrigger(registry, storage);

        await registry.tick();

        const stored = await registry.getTrigger(trigger.id);
        expect(stored).toMatchObject({ status: 'skipped', skipReason: 'start_failed: boom' });
        expect(stored?.firedAt).toBeUndefined();
      });

      it('does not queue one cancelled while an earlier fire ran', async () => {
        const captureService = makeCaptureService();
        const healthGate = makeHealthGate(true);
        const { registry, storage } = makeRegistry(captureService, healthGate);
        await createFiringTrigger(registry, storage, CONNECTION_ID, 'connections');
        await createFiringTrigger(registry, storage, CONNECTION_ID, 'memory_used');
        const triggers = await registry.listTriggers({ connectionId: CONNECTION_ID });
        captureService.startSession.mockImplementation(async ({ triggerId }) => {
          const other = triggers.find((t) => t.id !== triggerId)!;
          await registry.cancelTrigger(other.id);
          captureService.hasActiveSessionOn.mockReturnValue(true);
          return { id: 'sess-1', status: 'running' };
        });

        await registry.tick();

        const statuses = await registry.listTriggers({ connectionId: CONNECTION_ID });
        expect(statuses.map((t) => t.status).sort()).toEqual(['cancelled', 'fired']);
      });
    });

    it('queues a trigger whose gate failed and still fires the others', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const allowed = await healthGate.evaluate();
      healthGate.evaluate.mockImplementation(async (connectionId: string) => {
        if (connectionId === 'conn-1') {
          throw new Error('INFO timed out');
        }
        return allowed;
      });
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, 'conn-1', METRIC);
      await createFiringTrigger(registry, storage, 'conn-2', METRIC);

      await registry.tick();

      expect((await registry.listTriggers({ connectionId: 'conn-1' }))[0].status).toBe('queued');
      expect((await registry.listTriggers({ connectionId: 'conn-2' }))[0].status).toBe('fired');
    });

    it('fires a queued trigger once its gate recovers', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      healthGate.evaluate.mockRejectedValueOnce(new Error('INFO timed out'));
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, CONNECTION_ID, METRIC);

      await registry.tick();
      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('retries a trigger whose connection went away until it returns', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      healthGate.evaluate.mockRejectedValueOnce(new NotFoundException('Connection not found'));
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, CONNECTION_ID, METRIC);

      await registry.tick();
      expect((await registry.listTriggers({ connectionId: CONNECTION_ID }))[0].status).toBe(
        'queued',
      );

      await registry.tick();
      expect((await registry.listTriggers({ connectionId: CONNECTION_ID }))[0].status).toBe(
        'fired',
      );
    });

    it('retries a trigger whose connection went away as the session started', async () => {
      const captureService = makeCaptureService();
      captureService.startSession.mockRejectedValueOnce(
        new NotFoundException('Connection not found'),
      );
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      await createFiringTrigger(registry, storage, CONNECTION_ID, METRIC);

      await registry.tick();

      expect((await registry.listTriggers({ connectionId: CONNECTION_ID }))[0].status).toBe(
        'queued',
      );
    });

    it('matches the oldest event behind a full queue of newer ones', async () => {
      const captureService = makeCaptureService();
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      await registry.createTrigger({
        connectionId: CONNECTION_ID,
        metricType: METRIC,
        anomalyType: ANOMALY,
      });
      const start = Date.now() + 1;
      await storage.saveAnomalyEvent(makeAnomaly({ timestamp: start }), CONNECTION_ID);
      for (let i = 1; i < MAX_PENDING_ANOMALIES; i++) {
        await storage.saveAnomalyEvent(
          makeAnomaly({ metricType: 'memory_used', timestamp: start + i }),
          CONNECTION_ID,
        );
      }

      await registry.tick();

      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });

    it('reads no events while no trigger is waiting for one', async () => {
      const { registry, storage } = makeRegistry(makeCaptureService(), makeHealthGate(true));
      const read = jest.spyOn(storage, 'getAnomalyEvents');

      await registry.tick();

      expect(read).not.toHaveBeenCalled();
    });

    it('groups many triggers by connection in the order they load', async () => {
      const fired: string[] = [];
      const captureService = makeCaptureService();
      captureService.startSession.mockImplementation(async ({ triggerId }) => {
        fired.push(triggerId);
        return { id: `sess-${fired.length}`, status: 'running' };
      });
      const { registry, storage } = makeRegistry(captureService, makeHealthGate(true));
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'connections');
      await createFiringTrigger(registry, storage, CONNECTION_ID, 'memory_used');

      await registry.tick();

      expect(fired).toHaveLength(2);
    });

    it('does not make a connection wait for the gate of another', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const allowed = await healthGate.evaluate();
      let release: (result: unknown) => void = () => undefined;
      healthGate.evaluate.mockImplementation((connectionId: string) =>
        connectionId === 'conn-1'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(allowed),
      );
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, 'conn-1', METRIC);
      await createFiringTrigger(registry, storage, 'conn-2', METRIC);

      const tick = registry.tick();
      await settle();

      expect(captureService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'conn-2' }),
      );
      release(allowed);
      await tick;
    });

    it('loads the triggers once however many events arrived', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { registry, storage } = makeRegistry(captureService, healthGate);
      await createFiringTrigger(registry, storage, CONNECTION_ID, METRIC);
      for (const offset of [2, 3, 4]) {
        await storage.saveAnomalyEvent(
          makeAnomaly({ metricType: METRIC, timestamp: Date.now() + offset }),
          CONNECTION_ID,
        );
      }
      const load = jest.spyOn(storage, 'getCaptureTriggers');

      await registry.tick();

      expect(load).toHaveBeenCalledTimes(2);
    });

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
      await settle();
      expect(startCalls.length).toBe(1);
      startCalls[0].resolve();
      await firstTick;
      expect(captureService.startSession).toHaveBeenCalledTimes(1);
    });
  });
});
