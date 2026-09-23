import { HealthService } from '../health.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { ConfigHazardService } from '../../monitor/config-hazard.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';
import { DatabasePort } from '../../common/interfaces/database-port.interface';

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
  };
  let registry: ConnectionRegistry;
  let tracker: RuntimeCapabilityTracker;
  let configHazards: { getHazards: jest.Mock };

  beforeEach(() => {
    client = {
      isConnected: jest.fn().mockReturnValue(true),
      ping: jest.fn().mockResolvedValue(true),
      getCapabilities: jest.fn().mockReturnValue({ dbType: 'valkey', version: '8.1.0' }),
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

  it('ignores an external connection that has never pushed', async () => {
    const service = makeService();
    const getHealth = jest.spyOn(service, 'getHealth').mockResolvedValue({} as never);
    await (service as any).pollConnection(ctx(null));
    expect(getHealth).not.toHaveBeenCalled();
    await (service as any).pollConnection(ctx(123));
    expect(getHealth).toHaveBeenCalledWith('ext-1');
  });
});
