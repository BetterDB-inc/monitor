import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { CaptureScheduler } from '../capture-scheduler';
import type { HealthGateService } from '../health-gate.service';
import type { MonitorCaptureService } from '../monitor-capture.service';

const CONNECTION_ID = 'conn-1';

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

function makeScheduler(
  captureService: FakeCaptureService,
  healthGate: FakeHealthGate,
): {
  scheduler: CaptureScheduler;
  storage: MemoryAdapter;
  registry: SchedulerRegistry;
} {
  const storage = new MemoryAdapter();
  const registry = new SchedulerRegistry();
  const scheduler = new CaptureScheduler(
    storage,
    captureService as unknown as MonitorCaptureService,
    healthGate as unknown as HealthGateService,
    registry,
  );
  scheduler.setOptions({ autoStart: false });
  return { scheduler, storage, registry };
}

describe('CaptureScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createSchedule', () => {
    it('persists an enabled schedule and registers a Nest interval', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler, storage, registry } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });
      expect(schedule.status).toBe('enabled');
      expect(schedule.connectionId).toBe(CONNECTION_ID);
      expect(schedule.intervalSeconds).toBe(30);
      expect(schedule.durationMs).toBe(5000);

      const persisted = await storage.getScheduledCapture(schedule.id);
      expect(persisted).not.toBeNull();
      expect(
        registry.doesExist('interval', `monitor-schedule-interval-${schedule.id}`),
      ).toBe(true);

      registry.deleteInterval(`monitor-schedule-interval-${schedule.id}`);
    });

    it('rejects intervals below 10 seconds', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          intervalSeconds: 5,
          durationMs: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-positive duration', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          intervalSeconds: 30,
          durationMs: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects intervals above 24h', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          intervalSeconds: 100_000,
          durationMs: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when neither intervalSeconds nor cronExpression is provided', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          durationMs: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when both intervalSeconds and cronExpression are provided', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          intervalSeconds: 30,
          cronExpression: '*/2 * * * *',
          durationMs: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists a cron schedule and registers a Nest cron job', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler, storage, registry } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        cronExpression: '*/2 * * * *',
        durationMs: 5000,
      });
      expect(schedule.cronExpression).toBe('*/2 * * * *');
      expect(schedule.intervalSeconds).toBeUndefined();

      const persisted = await storage.getScheduledCapture(schedule.id);
      expect(persisted?.cronExpression).toBe('*/2 * * * *');
      expect(registry.doesExist('cron', `monitor-schedule-cron-${schedule.id}`)).toBe(true);

      await scheduler.deleteSchedule(schedule.id);
      expect(registry.doesExist('cron', `monitor-schedule-cron-${schedule.id}`)).toBe(false);
    });

    it('rejects an invalid cron expression', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(
        scheduler.createSchedule({
          connectionId: CONNECTION_ID,
          cronExpression: 'not a cron',
          durationMs: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('deleteSchedule', () => {
    it('removes the row and unregisters the interval', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler, storage, registry } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });
      const ok = await scheduler.deleteSchedule(schedule.id);
      expect(ok).toBe(true);
      expect(await storage.getScheduledCapture(schedule.id)).toBeNull();
      expect(
        registry.doesExist('interval', `monitor-schedule-interval-${schedule.id}`),
      ).toBe(false);
    });

    it('throws NotFound for unknown id', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      await expect(scheduler.deleteSchedule('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('fireOnce', () => {
    it('starts a session and records lastFiredAt/lastFiredSessionId on success', async () => {
      const captureService = makeCaptureService({ sessionId: 'sess-42' });
      const healthGate = makeHealthGate(true);
      const { scheduler, storage } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });

      await scheduler.fireOnce(schedule.id);

      expect(captureService.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: CONNECTION_ID,
          source: 'schedule',
          scheduleId: schedule.id,
          durationMs: 5000,
        }),
      );
      const updated = await storage.getScheduledCapture(schedule.id);
      expect(updated?.lastFiredSessionId).toBe('sess-42');
      expect(updated?.lastFiredAt).toBeGreaterThan(0);
      expect(updated?.lastSkipReason).toBeUndefined();

      await scheduler.deleteSchedule(schedule.id);
    });

    it('records the health-gate skip reason and does not start a session', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(false, 'memory_above_threshold');
      const { scheduler, storage } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });
      await scheduler.fireOnce(schedule.id);

      expect(captureService.startSession).not.toHaveBeenCalled();
      const updated = await storage.getScheduledCapture(schedule.id);
      expect(updated?.lastSkipReason).toBe('memory_above_threshold');
      expect(updated?.lastFiredSessionId).toBeUndefined();

      await scheduler.deleteSchedule(schedule.id);
    });

    it('skips with session_already_active when a session is running on the connection', async () => {
      const captureService = makeCaptureService({ active: true });
      const healthGate = makeHealthGate(true);
      const { scheduler, storage } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });
      await scheduler.fireOnce(schedule.id);

      expect(captureService.startSession).not.toHaveBeenCalled();
      const updated = await storage.getScheduledCapture(schedule.id);
      expect(updated?.lastSkipReason).toBe('session_already_active');

      await scheduler.deleteSchedule(schedule.id);
    });

    it('records start_failed when startSession throws', async () => {
      const captureService = makeCaptureService({
        throwOnStart: new Error('database down'),
      });
      const healthGate = makeHealthGate(true);
      const { scheduler, storage } = makeScheduler(captureService, healthGate);

      const schedule = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 5000,
      });
      await scheduler.fireOnce(schedule.id);

      const updated = await storage.getScheduledCapture(schedule.id);
      expect(updated?.lastSkipReason).toMatch(/^start_failed: /);

      await scheduler.deleteSchedule(schedule.id);
    });
  });

  describe('list / get', () => {
    it('returns persisted schedules sorted by createdAt desc', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);

      const first = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 30,
        durationMs: 1000,
      });
      await new Promise((r) => setTimeout(r, 5));
      const second = await scheduler.createSchedule({
        connectionId: CONNECTION_ID,
        intervalSeconds: 60,
        durationMs: 2000,
      });
      const list = await scheduler.listSchedules({ connectionId: CONNECTION_ID });
      expect(list.map((s) => s.id)).toEqual([second.id, first.id]);

      await scheduler.deleteSchedule(first.id);
      await scheduler.deleteSchedule(second.id);
    });

    it('getSchedule returns null for unknown id', async () => {
      const captureService = makeCaptureService();
      const healthGate = makeHealthGate(true);
      const { scheduler } = makeScheduler(captureService, healthGate);
      expect(await scheduler.getSchedule('does-not-exist')).toBeNull();
    });
  });
});
