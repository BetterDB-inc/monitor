import { ConfigHazardService } from '../config-hazard.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';

describe('ConfigHazardService', () => {
  const offDefaultUser = { flags: ['off'], commands: '-@all', keys: '', channels: '' };

  let client: {
    getConfigValue: jest.Mock;
    call: jest.Mock;
    getCapabilities: jest.Mock;
  };
  let registry: Pick<ConnectionRegistry, 'get'>;
  let service: ConfigHazardService;
  let now: number;

  beforeEach(() => {
    client = {
      getConfigValue: jest.fn().mockResolvedValue('yes'),
      call: jest.fn().mockResolvedValue(offDefaultUser),
      getCapabilities: jest.fn().mockReturnValue({ version: '8.1.0' }),
    };
    registry = { get: jest.fn().mockReturnValue(client) } as unknown as ConnectionRegistry;
    service = new ConfigHazardService(registry as ConnectionRegistry);
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      return now;
    });
  });

  afterEach(() => {
    (Date.now as jest.Mock).mockRestore();
  });

  it('returns the hazard finding for a hazardous config', async () => {
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('hazard');
    expect(client.call).toHaveBeenCalledWith('ACL', ['GETUSER', 'default']);
  });

  it('skips the ACL probe entirely when AOF is off', async () => {
    client.getConfigValue.mockResolvedValue('no');
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(0);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('maps a denied ACL GETUSER to an unverified finding', async () => {
    client.call.mockRejectedValue(new Error('NOPERM'));
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('unverified');
  });

  it('serves from the cache within the TTL', async () => {
    await service.getHazards('conn-1');
    await service.getHazards('conn-1');
    expect(client.getConfigValue).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the TTL expires', async () => {
    await service.getHazards('conn-1');
    now += 61_000;
    await service.getHazards('conn-1');
    expect(client.getConfigValue).toHaveBeenCalledTimes(2);
  });

  it('caches per connection, not globally', async () => {
    await service.getHazards('conn-1');
    await service.getHazards('conn-2');
    expect(client.getConfigValue).toHaveBeenCalledTimes(2);
  });

  it('returns no findings when the appendonly config cannot be read', async () => {
    client.getConfigValue.mockRejectedValue(new Error('ERR unknown command'));
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when the connection is not registered', async () => {
    (registry.get as jest.Mock).mockImplementation(() => {
      throw new Error('Connection not found');
    });
    const findings = await service.getHazards('missing');
    expect(findings).toHaveLength(0);
  });
});
