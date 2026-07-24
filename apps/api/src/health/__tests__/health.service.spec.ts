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
