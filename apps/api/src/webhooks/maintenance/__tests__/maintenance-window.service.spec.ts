import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import {
  MAX_MAINTENANCE_WINDOW_MS,
  MAX_OPEN_MAINTENANCE_WINDOWS,
  DeliveryStatus,
  WebhookEventType,
  maintenanceWindowCovers,
  maintenanceWindowEffectiveEnd,
  maintenanceWindowState,
  type MaintenanceWindow,
} from '@betterdb/shared';
import { MemoryAdapter } from '../../../storage/adapters/memory.adapter';
import type { ConnectionRegistry } from '../../../connections/connection-registry.service';
import { MaintenanceWindowService } from '../maintenance-window.service';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function window(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: 'mw-1',
    name: 'Upgrade',
    reason: null,
    connectionId: 'conn-1',
    events: [],
    startsAt: NOW - HOUR,
    endsAt: NOW + HOUR,
    endedAt: null,
    createdBy: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

describe('maintenance window helpers', () => {
  it('derives the state from start, end and an early end', () => {
    expect(maintenanceWindowState(window({ startsAt: NOW + 1 }), NOW)).toBe('scheduled');
    expect(maintenanceWindowState(window(), NOW)).toBe('active');
    expect(maintenanceWindowState(window({ startsAt: NOW }), NOW)).toBe('active');
    expect(maintenanceWindowState(window({ endsAt: NOW }), NOW)).toBe('ended');
    expect(maintenanceWindowState(window({ endedAt: NOW - 1 }), NOW)).toBe('ended');
  });

  it('uses the earlier of endsAt and endedAt as the effective end', () => {
    expect(maintenanceWindowEffectiveEnd(window())).toBe(NOW + HOUR);
    expect(maintenanceWindowEffectiveEnd(window({ endedAt: NOW }))).toBe(NOW);
    expect(maintenanceWindowEffectiveEnd(window({ endedAt: NOW + 2 * HOUR }))).toBe(NOW + HOUR);
  });

  it('covers only active windows, the right connection and the listed events', () => {
    const down = WebhookEventType.INSTANCE_DOWN;
    expect(maintenanceWindowCovers(window(), down, 'conn-1', NOW)).toBe(true);
    expect(maintenanceWindowCovers(window(), down, 'conn-2', NOW)).toBe(false);
    expect(maintenanceWindowCovers(window(), down, undefined, NOW)).toBe(false);
    expect(maintenanceWindowCovers(window({ connectionId: null }), down, 'conn-2', NOW)).toBe(true);
    expect(maintenanceWindowCovers(window({ connectionId: null }), down, undefined, NOW)).toBe(true);
    expect(maintenanceWindowCovers(window({ events: [WebhookEventType.MEMORY_CRITICAL] }), down, 'conn-1', NOW)).toBe(
      false,
    );
    expect(maintenanceWindowCovers(window({ startsAt: NOW + 1 }), down, 'conn-1', NOW)).toBe(false);
  });
});

describe('MaintenanceWindowService', () => {
  let storage: MemoryAdapter;
  let registry: { getConfig: jest.Mock };
  let service: MaintenanceWindowService;
  let replay: jest.Mock;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    storage = new MemoryAdapter();
    await storage.initialize();
    registry = { getConfig: jest.fn().mockReturnValue({ id: 'conn-1' }) };
    service = new MaintenanceWindowService(storage, registry as unknown as ConnectionRegistry);
    replay = jest.fn().mockResolvedValue(true);
    service.setReplayHandler(replay);
    await service.refresh();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    service.create({ name: 'Upgrade', connectionId: 'conn-1', endsAt: NOW + HOUR, ...overrides } as never, 'ops@example.com');

  describe('create', () => {
    it('starts now by default, records the creator and silences matching events at once', async () => {
      const created = await create({ reason: '  CHG-1  ', events: ['instance.down', 'instance.down'] });
      expect(created).toMatchObject({
        name: 'Upgrade',
        reason: 'CHG-1',
        connectionId: 'conn-1',
        events: ['instance.down'],
        startsAt: NOW,
        endsAt: NOW + HOUR,
        endedAt: null,
        createdBy: 'ops@example.com',
        state: 'active',
      });
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')?.id).toBe(created.id);
      expect(service.findSuppressing(WebhookEventType.MEMORY_CRITICAL, 'conn-1')).toBeNull();
    });

    it('stores a scheduled window that only silences once it starts', async () => {
      const created = await create({ startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });
      expect(created.state).toBe('scheduled');
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).toBeNull();
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1', NOW + HOUR)?.id).toBe(created.id);
    });

    it('covers every connection when connectionId is omitted', async () => {
      await create({ connectionId: undefined });
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'any')).not.toBeNull();
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, undefined)).not.toBeNull();
    });

    it('rejects a start in the past, an empty or reversed range and a window over 7 days', async () => {
      await expect(create({ startsAt: NOW - 10 * 60_000 })).rejects.toThrow(/past/);
      await expect(create({ startsAt: NOW + HOUR, endsAt: NOW + HOUR })).rejects.toThrow(/after startsAt/);
      await expect(create({ endsAt: NOW + MAX_MAINTENANCE_WINDOW_MS + 1 })).rejects.toThrow(/7 days/);
      await expect(create({ endsAt: NOW + MAX_MAINTENANCE_WINDOW_MS })).resolves.toBeDefined();
    });

    it('tolerates a few minutes of clock skew on the start', async () => {
      await expect(create({ startsAt: NOW - 60_000 })).resolves.toMatchObject({ state: 'active' });
    });

    it('rejects an unknown connection', async () => {
      registry.getConfig.mockReturnValue(null);
      await expect(create({ connectionId: 'ghost' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it(`caps open windows at ${MAX_OPEN_MAINTENANCE_WINDOWS}`, async () => {
      const repo = storage.getMaintenanceWindowRepository();
      for (let i = 0; i < MAX_OPEN_MAINTENANCE_WINDOWS; i++) {
        await repo.save(window({ id: `open-${i}` }));
      }
      await repo.save(window({ id: 'old', endsAt: NOW - 1 }));
      await expect(create()).rejects.toThrow(/At most 100/);
    });
  });

  describe('names', () => {
    it('rejects a blank name on create and update, leaving the stored name unchanged', async () => {
      await expect(service.create({ name: '   ', endsAt: NOW + HOUR } as never, null)).rejects.toThrow(BadRequestException);
      const created = await create();
      await expect(service.update(created.id, { name: '   ' } as never)).rejects.toThrow(BadRequestException);
      expect((await service.get(created.id)).name).toBe('Upgrade');
    });
  });

  describe('update, end and delete', () => {
    it('extends an active window and refuses to move its start', async () => {
      const created = await create();
      const extended = await service.update(created.id, { endsAt: NOW + 2 * HOUR, name: 'Longer' });
      expect(extended).toMatchObject({ endsAt: NOW + 2 * HOUR, name: 'Longer', state: 'active' });
      await expect(service.update(created.id, { startsAt: NOW + HOUR })).rejects.toThrow(/before the window starts/);
    });

    it('moves the start of a scheduled window', async () => {
      const created = await create({ startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });
      const moved = await service.update(created.id, { startsAt: NOW + 30 * 60_000 });
      expect(moved.startsAt).toBe(NOW + 30 * 60_000);
    });

    it('refuses to end a window through update or to touch an ended one', async () => {
      const created = await create({ startsAt: NOW - 60_000 });
      await expect(service.update(created.id, { endsAt: NOW - 1 })).rejects.toThrow(/end it now/);
      await service.end(created.id);
      await expect(service.update(created.id, { name: 'x' })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.end(created.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('ends a window early and stops silencing immediately', async () => {
      const created = await create();
      const ended = await service.end(created.id);
      expect(ended).toMatchObject({ endedAt: NOW, state: 'ended' });
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).toBeNull();
    });

    it('cancels a scheduled window', async () => {
      const created = await create({ startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });
      expect((await service.end(created.id)).state).toBe('ended');
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1', NOW + HOUR)).toBeNull();
    });

    it('deletes a window and 404s afterwards', async () => {
      const created = await create();
      await service.delete(created.id);
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).toBeNull();
      await expect(service.get(created.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.delete(created.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('orders active, then scheduled, then the most recently ended', async () => {
      const repo = storage.getMaintenanceWindowRepository();
      await repo.save(window({ id: 'ended-old', startsAt: NOW - 5 * HOUR, endsAt: NOW - 4 * HOUR }));
      await repo.save(window({ id: 'ended-new', startsAt: NOW - 3 * HOUR, endsAt: NOW - 2 * HOUR }));
      await repo.save(window({ id: 'scheduled', startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR }));
      await repo.save(window({ id: 'active' }));

      expect((await service.list()).map((view) => view.id)).toEqual(['active', 'scheduled', 'ended-new', 'ended-old']);
      expect((await service.list('scheduled')).map((view) => view.id)).toEqual(['scheduled']);
    });

    it('returns at most 20 ended windows without a state filter', async () => {
      const repo = storage.getMaintenanceWindowRepository();
      for (let i = 0; i < 25; i++) {
        await repo.save(window({ id: `ended-${i}`, startsAt: NOW - 3 * HOUR + i, endsAt: NOW - HOUR + i }));
      }
      expect(await service.list()).toHaveLength(20);
      expect(await service.list('ended')).toHaveLength(25);
    });
  });

  describe('fail-open and refresh', () => {
    it('suppresses nothing until the first load succeeds', async () => {
      const failing = {
        getMaintenanceWindowRepository: () => ({ list: jest.fn().mockRejectedValue(new Error('down')) }),
      };
      const cold = new MaintenanceWindowService(failing as never);
      jest.spyOn((cold as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      await cold.refresh();
      expect(cold.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).toBeNull();
    });

    it('keeps the last good copy when a later refresh fails', async () => {
      await create();
      jest.spyOn(storage.getMaintenanceWindowRepository(), 'list').mockRejectedValueOnce(new Error('blip'));
      jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      await service.refresh();
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).not.toBeNull();
    });

    it('picks up windows written by another replica on refresh', async () => {
      await storage.getMaintenanceWindowRepository().save(window({ id: 'remote' }));
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')).toBeNull();
      await service.refresh();
      expect(service.findSuppressing(WebhookEventType.INSTANCE_DOWN, 'conn-1')?.id).toBe('remote');
    });
  });

  describe('replay of alerts that outlive the window', () => {
    const down = WebhookEventType.INSTANCE_DOWN;
    const up = WebhookEventType.INSTANCE_UP;

    it('sends a silenced opener that is still unresolved when the window ends, once, with the window attached', async () => {
      const created = await create();
      expect(service.evaluate(down, { message: 'down' }, 'conn-1', NOW)?.id).toBe(created.id);

      expect(await service.replayEnded(NOW + 30 * 60_000)).toBe(0);
      expect(replay).not.toHaveBeenCalled();

      expect(await service.replayEnded(NOW + HOUR)).toBe(1);
      expect(replay).toHaveBeenCalledWith(
        down,
        {
          message: 'down',
          replayedAfterMaintenance: true,
          maintenanceWindow: { id: created.id, name: 'Upgrade', endedAt: NOW + HOUR },
        },
        'conn-1',
      );
      expect(await service.replayEnded(NOW + 2 * HOUR)).toBe(0);
      expect(replay).toHaveBeenCalledTimes(1);
    });

    it('forgets a silenced opener once its resolver arrives, and silences that resolver too', async () => {
      await create();
      expect(service.evaluate(WebhookEventType.WRITES_REJECTED, {}, 'conn-1', NOW)).not.toBeNull();
      expect(service.evaluate(WebhookEventType.WRITES_RECOVERED, {}, 'conn-1', NOW)).not.toBeNull();
      expect(service.pendingReplayCount()).toBe(0);
      expect(await service.replayEnded(NOW + HOUR)).toBe(0);
    });

    it('always sends the resolver of an opener that was sent before the window', async () => {
      expect(service.evaluate(down, {}, 'conn-1', NOW - 1)).toBeNull();
      service.settleOpener(down, 'conn-1', true);
      await create();
      // The incident instance.down opened must be able to close.
      expect(service.evaluate(up, {}, 'conn-1', NOW)).toBeNull();
      // Only once: a later flap inside the window is silenced again.
      expect(service.evaluate(down, {}, 'conn-1', NOW)).not.toBeNull();
      expect(service.evaluate(up, {}, 'conn-1', NOW)).not.toBeNull();
    });

    it('keeps the sent-opener record when an escalated opener is silenced inside the window', async () => {
      const rejected = WebhookEventType.WRITES_REJECTED;
      const recovered = WebhookEventType.WRITES_RECOVERED;
      expect(service.evaluate(rejected, {}, 'conn-1', NOW - 1)).toBeNull();
      service.settleOpener(rejected, 'conn-1', true);
      await create();
      expect(service.evaluate(rejected, { escalated: true }, 'conn-1', NOW)).not.toBeNull();
      expect(service.evaluate(recovered, {}, 'conn-1', NOW)).toBeNull();
      expect(service.pendingReplayCount()).toBe(0);
    });

    it('silences the recovery of an opener first seen inside the window, with nothing to replay', async () => {
      await create();
      expect(service.evaluate(WebhookEventType.WRITES_REJECTED, {}, 'conn-1', NOW)).not.toBeNull();
      expect(service.evaluate(WebhookEventType.WRITES_RECOVERED, {}, 'conn-1', NOW)).not.toBeNull();
      expect(await service.replayEnded(NOW + HOUR)).toBe(0);
    });

    it('replays an escalated opener that is still open when the window ends', async () => {
      const rejected = WebhookEventType.WRITES_REJECTED;
      service.evaluate(rejected, {}, 'conn-1', NOW - 1);
      service.settleOpener(rejected, 'conn-1', true);
      await create();
      service.evaluate(rejected, { escalated: true }, 'conn-1', NOW);
      expect(await service.replayEnded(NOW + HOUR)).toBe(1);
      expect(replay).toHaveBeenCalledWith(
        rejected,
        expect.objectContaining({ escalated: true, replayedAfterMaintenance: true }),
        'conn-1',
      );
    });

    it('does not count an opener as sent until the dispatcher marks it', async () => {
      expect(service.evaluate(down, {}, 'conn-1', NOW - 1)).toBeNull();
      service.settleOpener(down, 'conn-1', false);
      await create();
      expect(service.evaluate(up, {}, 'conn-1', NOW)).not.toBeNull();
    });

    it('does not track events that open nothing', async () => {
      await create();
      expect(service.evaluate(WebhookEventType.MEMORY_CRITICAL, {}, 'conn-1', NOW)).not.toBeNull();
      expect(service.pendingReplayCount()).toBe(0);
    });

    it('keeps openers per connection', async () => {
      await create({ connectionId: undefined });
      service.evaluate(down, {}, 'conn-1', NOW);
      service.evaluate(down, {}, 'conn-2', NOW);
      service.evaluate(up, {}, 'conn-1', NOW);
      expect(service.pendingReplayCount()).toBe(1);
      await service.replayEnded(NOW + HOUR);
      expect(replay).toHaveBeenCalledWith(down, expect.any(Object), 'conn-2');
    });

    it('names the overlapping window that ends last and waits for it', async () => {
      await create();
      const overlap = await create({ name: 'Overlap', endsAt: NOW + 3 * HOUR });
      expect(service.evaluate(down, {}, 'conn-1', NOW)?.id).toBe(overlap.id);

      expect(await service.replayEnded(NOW + HOUR)).toBe(0);
      expect(await service.replayEnded(NOW + 3 * HOUR)).toBe(1);
    });

    it('waits when the window it was silenced by ends but a later one still covers it', async () => {
      await create();
      service.evaluate(down, {}, 'conn-1', NOW);
      await create({ name: 'Follow-up', startsAt: NOW + 30 * 60_000, endsAt: NOW + 2 * HOUR });

      expect(await service.replayEnded(NOW + HOUR)).toBe(0);
      expect(await service.replayEnded(NOW + 2 * HOUR)).toBe(1);
      expect(replay.mock.calls[0][1]).toMatchObject({ maintenanceWindow: { name: 'Follow-up' } });
    });

    it('replays straight away when a window is ended or deleted by hand', async () => {
      const ended = await create();
      service.evaluate(down, {}, 'conn-1', NOW);
      await service.end(ended.id);
      expect(replay).toHaveBeenCalledTimes(1);

      const deleted = await create();
      service.evaluate(WebhookEventType.FAILOVER_STARTED, {}, 'conn-1', NOW);
      await service.delete(deleted.id);
      expect(replay).toHaveBeenCalledTimes(2);
      expect(replay).toHaveBeenLastCalledWith(WebhookEventType.FAILOVER_STARTED, expect.any(Object), 'conn-1');
    });

    it('drops a held-back alert whose replay fails instead of retrying it forever', async () => {
      await create();
      replay.mockRejectedValueOnce(new Error('dispatch failed'));
      jest.spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
      service.evaluate(down, {}, 'conn-1', NOW);
      expect(await service.replayEnded(NOW + HOUR)).toBe(0);
      expect(service.pendingReplayCount()).toBe(0);
    });
  });

  describe('in-flight openers', () => {
    const down = WebhookEventType.INSTANCE_DOWN;
    const up = WebhookEventType.INSTANCE_UP;

    it('sends the resolver of an opener that has not settled yet', async () => {
      expect(service.evaluate(down, {}, 'conn-1', NOW - 1)).toBeNull();
      await create();
      expect(service.evaluate(up, {}, 'conn-1', NOW)).toBeNull();
    });

    it('counts several in-flight openers for one key', async () => {
      service.evaluate(down, {}, 'conn-1', NOW - 1);
      service.evaluate(down, {}, 'conn-1', NOW - 1);
      service.settleOpener(down, 'conn-1', false);
      await create();
      expect(service.evaluate(up, {}, 'conn-1', NOW)).toBeNull();
    });
  });

  describe('lifecycle state rebuilt on startup', () => {
    const down = WebhookEventType.INSTANCE_DOWN;
    const up = WebhookEventType.INSTANCE_UP;
    let restarted: MaintenanceWindowService;

    afterEach(() => restarted?.onModuleDestroy());

    async function record(
      eventType: WebhookEventType,
      status: DeliveryStatus,
      at: number,
      responseBody?: string,
    ): Promise<void> {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(at);
      const webhook = await storage.createWebhook({
        name: 'hook',
        url: 'https://example.com/h',
        enabled: true,
        events: [eventType],
      } as never);
      await storage.createDelivery({
        webhookId: webhook.id,
        eventType,
        payload: { event: eventType, timestamp: at, data: { message: 'x' } },
        status,
        attempts: 0,
        responseBody,
        connectionId: 'conn-1',
      });
      spy.mockReturnValue(NOW);
    }

    async function restart(at: number = NOW): Promise<void> {
      jest.spyOn(Date, 'now').mockReturnValue(at);
      restarted = new MaintenanceWindowService(storage, registry as unknown as ConnectionRegistry);
      restarted.setReplayHandler(replay);
      await restarted.onModuleInit();
    }

    const suppressedBody = (id: string) => `Suppressed by maintenance window "Upgrade" (${id})`;

    it('holds a stored silenced opener and replays it when its window ends', async () => {
      const created = await create();
      await record(down, DeliveryStatus.SUPPRESSED, NOW, suppressedBody(created.id));
      await restart();
      expect(restarted.pendingReplayCount()).toBe(1);
      expect(await restarted.replayEnded(NOW + HOUR)).toBe(1);
      expect(replay).toHaveBeenCalledWith(
        down,
        expect.objectContaining({ message: 'x', replayedAfterMaintenance: true }),
        'conn-1',
      );
    });

    it('holds nothing when the silenced opener was followed by its resolver', async () => {
      const created = await create();
      await record(down, DeliveryStatus.SUPPRESSED, NOW - 2, suppressedBody(created.id));
      await record(up, DeliveryStatus.SUPPRESSED, NOW - 1, suppressedBody(created.id));
      await restart();
      expect(restarted.pendingReplayCount()).toBe(0);
      expect(await restarted.replayEnded(NOW + HOUR)).toBe(0);
      expect(replay).not.toHaveBeenCalled();
    });

    it('sends the resolver of an opener that was delivered before the window', async () => {
      await record(down, DeliveryStatus.SUCCESS, NOW - 1);
      await create();
      await restart();
      expect(restarted.evaluate(up, {}, 'conn-1', NOW)).toBeNull();
    });

    it('replays on the first tick an opener whose window ended during downtime', async () => {
      const created = await create();
      await record(down, DeliveryStatus.SUPPRESSED, NOW, suppressedBody(created.id));
      await restart(NOW + 2 * HOUR);
      expect(await restarted.replayEnded(NOW + 2 * HOUR)).toBe(1);
    });

    it('does not suppress resolvers, and warns, when the rebuild query fails', async () => {
      await create();
      jest.spyOn(storage, 'getDeliveriesForEventsSince').mockRejectedValue(new Error('db down'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await restart();
      expect(restarted.evaluate(up, {}, 'conn-1', NOW)).toBeNull();
      expect(warn).toHaveBeenCalled();
    });
  });
});
