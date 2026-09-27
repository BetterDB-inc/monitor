import { HealthService } from '../health.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { ConfigHazardService } from '../../monitor/config-hazard.service';

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

  it('returns disconnected without down edge while reconnect is still pending', async () => {
    client.isConnected.mockReturnValue(false);
    client.connect.mockReturnValue(new Promise(() => {}));
    const service = build(false);
    (service as unknown as { RECONNECT_TIMEOUT_MS: number }).RECONNECT_TIMEOUT_MS = 50;
    const [first, second] = await Promise.all([
      service.getHealth('conn-1'),
      service.getHealth('conn-1'),
    ]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('disconnected');
    expect(first.error).toBe('Reconnect in progress');
    expect(second.status).toBe('disconnected');
    expect(second.error).toBe('Reconnect in progress');
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
