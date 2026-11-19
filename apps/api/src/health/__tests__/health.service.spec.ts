import { HealthService } from '../health.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { ConfigHazardService } from '../../monitor/config-hazard.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';
import { DatabasePort } from '../../common/interfaces/database-port.interface';
import { WebhookDispatcherService } from '../../webhooks/webhook-dispatcher.service';
import { OtelEventDispatcherService } from '../../otel-telemetry/otel-event-dispatcher.service';

describe('HealthService detailed health', () => {
  const hazardFinding = {
    id: 'default-user-aof-data-loss' as const,
    severity: 'warning' as const,
    status: 'hazard' as const,
    message: 'The default user is disabled with AOF enabled (valkey#3983)',
  };

  let client: {
    isConnected: jest.Mock;
    ping: jest.Mock;
    getCapabilities: jest.Mock;
    connect: jest.Mock;
    refreshCapabilities: jest.Mock;
  };
  let registry: ConnectionRegistry;
  let tracker: RuntimeCapabilityTracker;
  let configHazards: { getHazards: jest.Mock };

  beforeEach(() => {
    client = {
      isConnected: jest.fn().mockReturnValue(true),
      ping: jest.fn().mockResolvedValue(true),
      getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
      connect: jest.fn().mockResolvedValue(undefined),
      refreshCapabilities: jest.fn().mockResolvedValue(undefined),
    };
    registry = {
      list: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(client),
      getConfig: jest.fn().mockReturnValue({ host: 'localhost', port: 6379 }),
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
    } as unknown as ConnectionRegistry;
    tracker = {
      getCapabilities: jest.fn().mockReturnValue(null),
      getDisabledReasons: jest.fn().mockReturnValue(null),
    } as unknown as RuntimeCapabilityTracker;
    configHazards = { getHazards: jest.fn().mockResolvedValue([hazardFinding]) };
  });

  const build = (withHazardService: boolean): HealthService => {
    return new HealthService(
      registry,
      tracker,
      undefined,
      undefined,
      undefined,
      undefined,
      withHazardService ? (configHazards as unknown as ConfigHazardService) : undefined,
    );
  };

  it('includes configHazards from the hazard service', async () => {
    const service = build(true);
    const detailed = await service.getDetailedHealth('conn-1');
    expect(detailed.configHazards).toEqual([hazardFinding]);
    expect(configHazards.getHazards).toHaveBeenCalledWith('conn-1');
  });

  it('resolves the default connection for the hazard probe when none is given', async () => {
    const service = build(true);
    await service.getDetailedHealth();
    expect(configHazards.getHazards).toHaveBeenCalledWith('conn-1');
  });

  it('omits configHazards when the hazard service is not wired', async () => {
    const service = build(false);
    const detailed = await service.getDetailedHealth('conn-1');
    expect(detailed.configHazards).toBeUndefined();
  });

  it('still returns detailed health when the hazard probe throws', async () => {
    configHazards.getHazards.mockRejectedValue(new Error('probe failed'));
    const service = build(true);
    const detailed = await service.getDetailedHealth('conn-1');
    expect(detailed.status).toBe('connected');
    expect(detailed.configHazards).toEqual([]);
  });

  it('retries connect when disconnected and returns connected after recovery', async () => {
    client.isConnected
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    client.connect.mockImplementation(async () => {
      client.isConnected.mockReturnValue(true);
    });
    const service = build(false);
    const health = await service.getHealth('conn-1');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(health.status).toBe('connected');
  });

  it('returns disconnected when reconnect fails', async () => {
    client.isConnected.mockReturnValue(false);
    client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = build(false);
    const health = await service.getHealth('conn-1');
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(health.status).toBe('disconnected');
  });

  it('refreshes capabilities when missing after late connect', async () => {
    client.getCapabilities
      .mockImplementationOnce(() => {
        throw new Error('Capabilities not yet detected. Call connect() first.');
      })
      .mockReturnValue({ dbType: 'redis', version: '7.2.0' });
    const service = build(false);
    const health = await service.getHealth('conn-1');
    expect(client.refreshCapabilities).toHaveBeenCalledTimes(1);
    expect(health.status).toBe('connected');
    expect(health.database.version).toBe('7.2.0');
  });

  it('emits the down edge even while reconnect is still pending', async () => {
    client.isConnected.mockReturnValue(false);
    client.connect.mockReturnValue(new Promise(() => {}));
    const webhooks = { dispatchHealthChange: jest.fn().mockResolvedValue(undefined) };
    const otelEvents = { dispatch: jest.fn() };
    const service = new HealthService(
      registry,
      tracker,
      webhooks as unknown as WebhookDispatcherService,
      undefined,
      undefined,
      otelEvents as unknown as OtelEventDispatcherService,
    );
    (service as unknown as { RECONNECT_TIMEOUT_MS: number }).RECONNECT_TIMEOUT_MS = 50;
    const [first, second] = await Promise.all([
      service.getHealth('conn-1'),
      service.getHealth('conn-1'),
    ]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('disconnected');
    expect(first.error).toBe('Not connected to database');
    expect(second.status).toBe('disconnected');
    expect(second.error).toBe('Not connected to database');
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(otelEvents.dispatch).toHaveBeenCalledTimes(1);
  });

  it('returns connected degraded when capability refresh fails after ping', async () => {
    client.getCapabilities.mockImplementation(() => {
      throw new Error('Capabilities not yet detected. Call connect() first.');
    });
    client.refreshCapabilities.mockRejectedValue(new Error('slow'));
    const service = build(false);
    const health = await service.getHealth('conn-1');
    expect(health.status).toBe('connected');
    expect(health.capabilities).toBeNull();
  });
});

describe('HealthService external connections', () => {
  const makeService = () =>
    new HealthService(
      {
        list: jest.fn().mockReturnValue([]),
        get: jest.fn(),
        getConfig: jest.fn().mockReturnValue({ host: 'cache.internal', port: 6379 }),
        getDefaultId: jest.fn().mockReturnValue('ext-1'),
      } as unknown as ConnectionRegistry,
      { getCapabilities: jest.fn(), getDisabledReasons: jest.fn() } as unknown as RuntimeCapabilityTracker,
    );

  const ctx = (sampleVersion: number | null): ConnectionContext => ({
    connectionId: 'ext-1',
    connectionName: 'pushed',
    client: { sampleVersion: () => sampleVersion } as unknown as DatabasePort,
    host: 'cache.internal',
    port: 6379,
    connectionType: 'external',
  });

  it('opts in and polls every tick', () => {
    const service = makeService();
    expect((service as any).supportsExternalConnections()).toBe(true);
    expect((service as any).skipUnchangedSamples()).toBe(false);
  });

  describe('getHealth before the first OTLP sample', () => {
    const buildWithDispatchers = (sampleVersion: number | null) => {
      const client = {
        isConnected: jest.fn().mockReturnValue(false),
        ping: jest.fn().mockResolvedValue(false),
        sampleVersion: jest.fn().mockReturnValue(sampleVersion),
      };
      const webhooks = { dispatchHealthChange: jest.fn().mockResolvedValue(undefined) };
      const otelEvents = { dispatch: jest.fn() };
      const service = new HealthService(
        {
          list: jest.fn().mockReturnValue([]),
          get: jest.fn().mockReturnValue(client),
          getConfig: jest.fn().mockReturnValue({ host: 'cache.internal', port: 6379, connectionType: 'external' }),
          getDefaultId: jest.fn().mockReturnValue('ext-1'),
        } as unknown as ConnectionRegistry,
        { getCapabilities: jest.fn(), getDisabledReasons: jest.fn() } as unknown as RuntimeCapabilityTracker,
        webhooks as unknown as WebhookDispatcherService,
        undefined,
        undefined,
        otelEvents as unknown as OtelEventDispatcherService,
      );
      return { service, webhooks, otelEvents };
    };

    it('reports waiting without dispatching instance.down', async () => {
      const { service, webhooks, otelEvents } = buildWithDispatchers(null);
      const health = await service.getHealth('ext-1');
      expect(health).toEqual({
        status: 'waiting',
        database: { type: 'unknown', version: null, host: 'cache.internal', port: 6379 },
        capabilities: null,
        runtimeCapabilities: null,
        message: 'Waiting for first OTLP sample',
      });
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
      expect(otelEvents.dispatch).not.toHaveBeenCalled();
      expect((service as any).instanceUpStates.get('ext-1')).not.toBe(false);
    });

    it('still reports instance.down once a pushed connection goes stale', async () => {
      const { service, webhooks, otelEvents } = buildWithDispatchers(123);
      const health = await service.getHealth('ext-1');
      expect(health.status).toBe('disconnected');
      expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
      expect(otelEvents.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores an external connection that has never pushed', async () => {
    const service = makeService();
    const checkHealth = jest.spyOn(service as any, 'checkHealth').mockResolvedValue({} as never);
    await (service as any).pollConnection(ctx(null));
    expect(checkHealth).not.toHaveBeenCalled();
    await (service as any).pollConnection(ctx(123));
    expect(checkHealth).toHaveBeenCalledWith('ext-1', true);
  });
});

describe('HealthService getAllConnectionsHealth', () => {
  const statusesToOverall = async (statuses: Array<'connected' | 'disconnected' | 'error' | 'waiting'>) => {
    const registry = {
      list: jest.fn().mockReturnValue(statuses.map((_, i) => ({ id: `c${i}`, name: `conn-${i}` }))),
    } as unknown as ConnectionRegistry;
    const service = new HealthService(registry, {} as RuntimeCapabilityTracker);
    jest.spyOn(service, 'getHealth').mockImplementation(async (id?: string) => ({
      status: statuses[Number(id?.slice(1))],
      database: { type: 'unknown', version: null, host: 'h', port: 1 },
      capabilities: null,
      runtimeCapabilities: null,
    }));
    return (await service.getAllConnectionsHealth()).overallStatus;
  };

  it('reports waiting when every connection is waiting', async () => {
    expect(await statusesToOverall(['waiting'])).toBe('waiting');
    expect(await statusesToOverall(['waiting', 'waiting'])).toBe('waiting');
  });

  it('ignores waiting connections next to connected ones', async () => {
    expect(await statusesToOverall(['connected', 'waiting'])).toBe('healthy');
  });

  it('ignores waiting connections when the rest are down', async () => {
    expect(await statusesToOverall(['disconnected', 'waiting'])).toBe('unhealthy');
  });

  it('reports degraded for a mix of connected and down beside waiting ones', async () => {
    expect(await statusesToOverall(['connected', 'error', 'waiting'])).toBe('degraded');
  });
});

describe('HealthService ping deadline', () => {
  const PING_TIMEOUT_MS = 5000;
  let client: {
    isConnected: jest.Mock;
    ping: jest.Mock;
    getCapabilities: jest.Mock;
    connect: jest.Mock;
    disconnect: jest.Mock;
    pingOnNewConnection?: jest.Mock;
    reconnectClient?: jest.Mock;
  };
  let webhooks: { dispatchHealthChange: jest.Mock };
  let config: { host: string; port: number; connectionType?: string };

  const build = (): HealthService =>
    new HealthService(
      {
        list: jest.fn().mockReturnValue([]),
        get: jest.fn().mockReturnValue(client),
        getConfig: jest.fn().mockImplementation(() => config),
        getDefaultId: jest.fn().mockReturnValue('conn-1'),
      } as unknown as ConnectionRegistry,
      {
        getCapabilities: jest.fn().mockReturnValue(null),
        getDisabledReasons: jest.fn().mockReturnValue(null),
      } as unknown as RuntimeCapabilityTracker,
      webhooks as unknown as WebhookDispatcherService,
    );

  const hang = () => new Promise<boolean>(() => {});

  const checkAfterDeadline = async (service: HealthService) => {
    const pending = service.getHealth('conn-1');
    await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    return pending;
  };

  const startPollerCheck = (service: HealthService): Promise<void> =>
    (service as unknown as { pollConnection(ctx: ConnectionContext): Promise<void> }).pollConnection({
      connectionId: 'conn-1',
      connectionName: 'conn-1',
      client: client as unknown as DatabasePort,
      host: config.host,
      port: config.port,
    });

  const pollerCheckAfterDeadline = async (service: HealthService) => {
    const pending = startPollerCheck(service);
    await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await pending;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    client = {
      isConnected: jest.fn().mockReturnValue(true),
      ping: jest.fn().mockResolvedValue(true),
      getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    webhooks = { dispatchHealthChange: jest.fn().mockResolvedValue(undefined) };
    config = { host: 'localhost', port: 6379 };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('gives up on a ping that does not answer within the deadline', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    const pending = service.getHealth('conn-1');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const health = await pending;
    expect(health.status).toBe('error');
    expect(health.error).toBe('Database ping timed out');
  });

  it('does not report the instance down after one missed poller check', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('reports the instance down and drops the client after two missed poller checks in a row', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    await pollerCheckAfterDeadline(service);
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(webhooks.dispatchHealthChange.mock.calls[0][1]).toMatchObject({
      reason: 'Database ping timed out',
    });
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('never reports down or drops the client for pings missed by other callers', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    for (let check = 0; check < 6; check++) {
      expect((await checkAfterDeadline(service)).error).toBe('Database ping timed out');
    }
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('waits for the second poller check when another caller misses a ping in between', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    await pollerCheckAfterDeadline(service);
    await checkAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('counts a poller check that joined a ping another caller started', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    for (let round = 0; round < 2; round++) {
      const caller = service.getHealth('conn-1');
      await jest.advanceTimersByTimeAsync(2000);
      const poller = startPollerCheck(service);
      await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 2000);
      await Promise.all([caller, poller]);
    }
    expect(client.ping).toHaveBeenCalledTimes(2);
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('starts counting again after a ping that answers any caller', async () => {
    const service = build();
    client.ping.mockImplementationOnce(hang);
    await pollerCheckAfterDeadline(service);
    expect((await service.getHealth('conn-1')).status).toBe('connected');
    client.ping.mockImplementationOnce(hang);
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('counts one miss when the poller and other callers wait on the same stalled ping', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    const callers = [service.getHealth('conn-1'), service.getHealth('conn-1')];
    const poller = startPollerCheck(service);
    await jest.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    const results = await Promise.all(callers);
    await poller;
    expect(results.map((health) => health.error)).toEqual([
      'Database ping timed out',
      'Database ping timed out',
    ]);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('reports the instance down at once when the ping is refused', async () => {
    client.ping.mockResolvedValue(false);
    const service = build();
    const health = await service.getHealth('conn-1');
    expect(health.error).toBe('Database ping failed');
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('keeps the client of an agent connection after two missed pings', async () => {
    config = { host: 'agent', port: 0 };
    client.ping.mockImplementation(hang);
    const service = build();
    client.pingOnNewConnection = jest.fn().mockResolvedValue(true);
    await pollerCheckAfterDeadline(service);
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.pingOnNewConnection).not.toHaveBeenCalled();
  });

  it('still reports down when dropping the client fails', async () => {
    client.ping.mockImplementation(hang);
    client.disconnect.mockRejectedValue(new Error('socket already closed'));
    const service = build();
    await pollerCheckAfterDeadline(service);
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
    expect(webhooks.dispatchHealthChange.mock.calls[0][1]).toMatchObject({
      reason: 'Database ping timed out',
    });
  });

  it('forgets missed pings when the connection is removed', async () => {
    client.ping.mockImplementation(hang);
    const service = build();
    await pollerCheckAfterDeadline(service);
    (service as unknown as { onConnectionRemoved(id: string): void }).onConnectionRemoved('conn-1');
    await pollerCheckAfterDeadline(service);
    expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
  });

  describe('when the client can ping on a new connection', () => {
    const QUIET_RECONNECT_AFTER_MISSES = 6;

    beforeEach(() => {
      client.ping.mockImplementation(hang);
      client.pingOnNewConnection = jest.fn().mockResolvedValue(true);
    });

    it('does not report down or drop the client when the new connection answers', async () => {
      const service = build();
      await pollerCheckAfterDeadline(service);
      await pollerCheckAfterDeadline(service);
      expect(client.pingOnNewConnection).toHaveBeenCalledTimes(1);
      expect(client.pingOnNewConnection).toHaveBeenCalledWith(PING_TIMEOUT_MS);
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('reports down and drops the client when the new connection gets no answer either', async () => {
      client.pingOnNewConnection!.mockResolvedValue(false);
      const service = build();
      await pollerCheckAfterDeadline(service);
      await pollerCheckAfterDeadline(service);
      expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
      expect(webhooks.dispatchHealthChange.mock.calls[0][1]).toMatchObject({
        reason: 'Database ping timed out',
      });
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('reports down when the ping on the new connection never settles', async () => {
      client.pingOnNewConnection!.mockImplementation(hang);
      const service = build();
      await pollerCheckAfterDeadline(service);
      await pollerCheckAfterDeadline(service);
      expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('reports down when the ping on the new connection fails', async () => {
      client.pingOnNewConnection!.mockRejectedValue(new Error('tunnel is gone'));
      const service = build();
      await pollerCheckAfterDeadline(service);
      await pollerCheckAfterDeadline(service);
      expect(webhooks.dispatchHealthChange).toHaveBeenCalledTimes(1);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    });

    it('opens no new connection before a miss is counted or for other callers', async () => {
      const service = build();
      await pollerCheckAfterDeadline(service);
      await checkAfterDeadline(service);
      expect(client.pingOnNewConnection).not.toHaveBeenCalled();
    });

    it('ignores the new connection when the client answers the second check', async () => {
      const service = build();
      await pollerCheckAfterDeadline(service);
      client.ping.mockResolvedValue(true);
      client.pingOnNewConnection!.mockResolvedValue(false);
      await pollerCheckAfterDeadline(service);
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('reconnects the client without reporting down after six missed checks the new connection answered', async () => {
      client.disconnect.mockImplementation(async () => {
        client.isConnected.mockReturnValue(false);
      });
      client.connect.mockImplementation(async () => {
        client.isConnected.mockReturnValue(true);
      });
      const service = build();
      for (let check = 1; check < QUIET_RECONNECT_AFTER_MISSES; check++) {
        await pollerCheckAfterDeadline(service);
      }
      expect(client.disconnect).not.toHaveBeenCalled();

      await pollerCheckAfterDeadline(service);

      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    });

    it('reconnects only the main client when the adapter can, so a CLI session stays open', async () => {
      client.reconnectClient = jest.fn().mockResolvedValue(undefined);
      const service = build();
      for (let check = 1; check <= QUIET_RECONNECT_AFTER_MISSES; check++) {
        await pollerCheckAfterDeadline(service);
      }

      expect(client.reconnectClient).toHaveBeenCalledTimes(1);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    });

    it('counts from the start again after the quiet reconnect', async () => {
      const service = build();
      for (let check = 1; check <= QUIET_RECONNECT_AFTER_MISSES; check++) {
        await pollerCheckAfterDeadline(service);
      }
      client.pingOnNewConnection!.mockClear();

      await pollerCheckAfterDeadline(service);

      expect(client.pingOnNewConnection).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(webhooks.dispatchHealthChange).not.toHaveBeenCalled();
    });
  });
});
