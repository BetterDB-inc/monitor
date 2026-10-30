import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { DeliveryStatus, WebhookEventType, type Webhook, type WebhookDelivery } from '@betterdb/shared';
import { WebhookDispatcherService } from '../../webhook-dispatcher.service';
import type { WebhooksService } from '../../webhooks.service';
import type { ConnectionRegistry } from '../../../connections/connection-registry.service';
import { MemoryAdapter } from '../../../storage/adapters/memory.adapter';
import { MaintenanceWindowService } from '../maintenance-window.service';

const HOUR = 60 * 60 * 1000;

describe('WebhookDispatcherService with maintenance windows', () => {
  let server: Server;
  let port: number;
  let received: Array<{ event: string }>;
  let storage: MemoryAdapter;
  let maintenance: MaintenanceWindowService;
  let dispatcher: WebhookDispatcherService;
  let webhooks: Webhook[];
  let now: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(async () => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    received = [];
    storage = new MemoryAdapter();
    await storage.initialize();
    const hook = await storage.createWebhook({
      name: 'Ops',
      url: `http://127.0.0.1:${port}/hook`,
      secret: 'whsec_x',
      enabled: true,
      events: [
        WebhookEventType.INSTANCE_DOWN,
        WebhookEventType.INSTANCE_UP,
        WebhookEventType.MEMORY_CRITICAL,
        WebhookEventType.ANOMALY_DETECTED,
      ],
      headers: {},
      retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
      connectionId: 'conn-1',
    });
    webhooks = [hook];

    maintenance = new MaintenanceWindowService(storage, {
      getConfig: jest.fn().mockReturnValue({ id: 'conn-1' }),
    } as unknown as ConnectionRegistry);
    await maintenance.refresh();

    dispatcher = new WebhookDispatcherService(
      storage,
      {
        getWebhooksByEvent: jest.fn((event: WebhookEventType) =>
          Promise.resolve(webhooks.filter((webhook) => webhook.events.includes(event))),
        ),
        generateSignature: jest.fn().mockReturnValue('sig'),
      } as unknown as WebhooksService,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      undefined,
      maintenance,
    );
  });

  afterEach(() => {
    maintenance.onModuleDestroy();
    jest.restoreAllMocks();
  });

  const deliveries = async (): Promise<WebhookDelivery[]> => storage.getDeliveriesByWebhook(webhooks[0].id, 100);
  const openWindow = (overrides: Record<string, unknown> = {}) =>
    maintenance.create({ name: 'Upgrade', connectionId: 'conn-1', endsAt: now + HOUR, ...overrides } as never, null);

  it('sends normally when no window covers the event', async () => {
    await expect(dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1')).resolves.toBe(true);
    expect(received.map((body) => body.event)).toEqual(['instance.down']);
    expect((await deliveries())[0].status).toBe(DeliveryStatus.SUCCESS);
  });

  it('records a suppressed delivery instead of sending while a window is active', async () => {
    const window = await openWindow();

    await expect(dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1')).resolves.toBe(true);

    expect(received).toHaveLength(0);
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({
      status: DeliveryStatus.SUPPRESSED,
      attempts: 0,
      eventType: WebhookEventType.INSTANCE_DOWN,
      responseBody: `Suppressed by maintenance window "Upgrade" (${window.id})`,
      connectionId: 'conn-1',
    });
    expect(delivery.completedAt).toBe(now);
  });

  it('only silences the events and connection the window lists', async () => {
    await openWindow({ events: [WebhookEventType.INSTANCE_DOWN] });

    await dispatcher.dispatchEvent(WebhookEventType.ANOMALY_DETECTED, { message: 'spike' }, 'conn-1');
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'other node' }, 'conn-2');

    expect(received.map((body) => body.event)).toEqual(['anomaly.detected', 'instance.down']);
  });

  it('sends a still-open opener when the window ends, and nothing once it resolved', async () => {
    const window = await openWindow();
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    expect(received).toHaveLength(0);

    now += HOUR;
    await maintenance.replayEnded(now);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: 'instance.down',
      data: {
        message: 'down',
        replayedAfterMaintenance: true,
        maintenanceWindow: { id: window.id, name: 'Upgrade', endedAt: now },
      },
    });
  });

  it('does not replay an opener whose recovery also happened inside the window', async () => {
    await openWindow();
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

    now += HOUR;
    await maintenance.replayEnded(now);

    expect(received).toHaveLength(0);
    expect((await deliveries()).map((delivery) => delivery.status)).toEqual([
      DeliveryStatus.SUPPRESSED,
      DeliveryStatus.SUPPRESSED,
    ]);
  });

  it('still sends the recovery of an outage that started before the window, so incidents can close', async () => {
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    await openWindow();
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

    expect(received.map((body) => body.event)).toEqual(['instance.down', 'instance.up']);
  });

  it('judges an event retried through the storage buffer by its first decision', async () => {
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    await openWindow();
    const evaluate = jest.spyOn(maintenance, 'evaluate');
    const createDelivery = jest.spyOn(storage, 'createDelivery').mockRejectedValueOnce(new Error('storage down'));

    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');
    expect(createDelivery).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);

    await (dispatcher as unknown as { flushStorageRetryBuffer(): Promise<void> }).flushStorageRetryBuffer();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(received.map((body) => body.event)).toEqual(['instance.down', 'instance.up']);
  });

  it('leaves threshold hysteresis untouched while silenced, so a breach that outlives the window still alerts', async () => {
    await openWindow();
    const fire = () =>
      dispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_critical',
        95,
        'memoryCriticalPercent',
        true,
        { message: 'Memory at 95%' },
        'conn-1',
      );

    await expect(fire()).resolves.toBe(false);
    expect(received).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);

    now += HOUR;
    await expect(fire()).resolves.toBe(true);
    expect(received.map((body) => body.event)).toEqual(['memory.critical']);
  });

  it('applies the same rule to the global-threshold path', async () => {
    await openWindow();
    const fire = () =>
      dispatcher.dispatchThresholdAlert(WebhookEventType.MEMORY_CRITICAL, 'mem:conn-1', 95, 90, true, {}, 'conn-1');

    await expect(fire()).resolves.toBe(false);
    now += HOUR;
    await expect(fire()).resolves.toBe(true);
    expect(received).toHaveLength(1);
  });

  it('sends the recovery after an escalated opener was silenced inside the window', async () => {
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    await openWindow();
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down', escalated: true }, 'conn-1');
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

    expect(received.map((body) => body.event)).toEqual(['instance.down', 'instance.up']);
  });

  it('suppresses the recovery of an outage nobody was told about (no subscriber)', async () => {
    webhooks[0].events = [WebhookEventType.INSTANCE_UP];
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    webhooks[0].events = [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP];
    await openWindow();
    await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

    expect(received).toHaveLength(0);
    expect((await deliveries())[0].status).toBe(DeliveryStatus.SUPPRESSED);
  });

  describe('opener acceptance by the receiver', () => {
    let status: number;
    let flaky: Server;

    beforeEach(async () => {
      status = 400;
      flaky = createServer((req, res) => {
        req.resume();
        req.on('end', () => res.writeHead(status).end('no'));
      });
      await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
      webhooks[0].url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/hook`;
    });

    afterEach(() => new Promise<void>((resolve) => flaky.close(() => resolve())));

    it('suppresses the recovery when the opener failed terminally', async () => {
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
      await openWindow();
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

      const statuses = (await deliveries()).map((delivery) => delivery.status);
      expect(statuses).toContain(DeliveryStatus.SUPPRESSED);
    });

    it('sends the recovery when the opener is merely retrying', async () => {
      status = 500;
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
      await openWindow();
      status = 200;
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');

      const statuses = (await deliveries()).map((delivery) => delivery.status);
      expect(statuses).not.toContain(DeliveryStatus.SUPPRESSED);
      const recovery = (await deliveries()).filter((d) => d.eventType === WebhookEventType.INSTANCE_UP);
      expect(recovery.map((d) => d.status)).toContain(DeliveryStatus.SUCCESS);
    });

    it('sends the recovery while its opener is still in flight', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let openerArrived!: () => void;
      const arrived = new Promise<void>((resolve) => (openerArrived = resolve));
      await new Promise<void>((resolve) => flaky.close(() => resolve()));
      flaky = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          if (JSON.parse(body).event === WebhookEventType.INSTANCE_DOWN) {
            openerArrived();
            void gate.then(() => res.writeHead(200).end('ok'));
          } else {
            res.writeHead(200).end('ok');
          }
        });
      });
      await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
      webhooks[0].url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/hook`;

      const opener = dispatcher.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
      await arrived;
      await openWindow();
      await dispatcher.dispatchEvent(WebhookEventType.INSTANCE_UP, { message: 'up' }, 'conn-1');
      release();
      await opener;

      const all = await deliveries();
      expect(all.map((d) => d.status)).not.toContain(DeliveryStatus.SUPPRESSED);
      expect(all.filter((d) => d.eventType === WebhookEventType.INSTANCE_UP).map((d) => d.status)).toContain(
        DeliveryStatus.SUCCESS,
      );
    });
  });

  it('does not record a fired edge when a window opens during the webhook lookup', async () => {
    const lookup = (dispatcher as unknown as { webhooksService: { getWebhooksByEvent: jest.Mock } }).webhooksService
      .getWebhooksByEvent;
    lookup.mockImplementationOnce(async () => {
      await openWindow();
      return webhooks;
    });
    const fire = () =>
      dispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_critical',
        95,
        'memoryCriticalPercent',
        true,
        { message: 'Memory at 95%' },
        'conn-1',
      );

    await expect(fire()).resolves.toBe(false);
    expect(received).toHaveLength(0);

    now += HOUR;
    await expect(fire()).resolves.toBe(true);
    expect(received.map((body) => body.event)).toEqual(['memory.critical']);
  });

  describe('threshold recovery while silenced', () => {
    const perWebhook = (value: number) =>
      dispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_critical',
        value,
        'memoryCriticalPercent',
        true,
        { message: `Memory at ${value}%` },
        'conn-1',
      );
    const global = (value: number) =>
      dispatcher.dispatchThresholdAlert(WebhookEventType.MEMORY_CRITICAL, 'mem:conn-1', value, 90, true, {}, 'conn-1');

    it.each([
      ['per-webhook', perWebhook],
      ['global', global],
    ])('alerts after the window when the condition dipped and returned inside it (%s path)', async (_name, fire) => {
      await expect(fire(95)).resolves.toBe(true);
      await openWindow();
      await expect(fire(50)).resolves.toBe(false);
      await expect(fire(95)).resolves.toBe(false);
      expect(received).toHaveLength(1);

      now += HOUR;
      await expect(fire(95)).resolves.toBe(true);
      expect(received).toHaveLength(2);
    });

    it.each([
      ['per-webhook', perWebhook],
      ['global', global],
    ])('keeps the fired state while the value stays high inside the window (%s path)', async (_name, fire) => {
      await expect(fire(95)).resolves.toBe(true);
      await openWindow();
      await expect(fire(96)).resolves.toBe(false);

      now += HOUR;
      await expect(fire(96)).resolves.toBe(false);
      expect(received).toHaveLength(1);
    });
  });

  it('keeps sending when maintenance windows could not be loaded', async () => {
    const cold = new MaintenanceWindowService({
      getMaintenanceWindowRepository: () => ({ list: jest.fn().mockRejectedValue(new Error('down')) }),
    } as never);
    jest.spyOn((cold as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
    await cold.refresh();
    const failOpen = new WebhookDispatcherService(
      storage,
      {
        getWebhooksByEvent: jest.fn().mockResolvedValue(webhooks),
        generateSignature: jest.fn().mockReturnValue('sig'),
      } as unknown as WebhooksService,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      undefined,
      cold,
    );

    await failOpen.dispatchEvent(WebhookEventType.INSTANCE_DOWN, { message: 'down' }, 'conn-1');
    expect(received).toHaveLength(1);
  });
});
