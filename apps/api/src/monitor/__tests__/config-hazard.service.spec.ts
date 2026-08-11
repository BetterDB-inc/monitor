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

  function appendonlyProbeCount(): number {
    return client.getConfigValue.mock.calls.filter((args: string[]) => {
      return args[0] === 'appendonly';
    }).length;
  }

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
    expect(appendonlyProbeCount()).toBe(1);
  });

  it('re-probes after the TTL expires', async () => {
    await service.getHazards('conn-1');
    now += 61_000;
    await service.getHazards('conn-1');
    expect(appendonlyProbeCount()).toBe(2);
  });

  it('caches per connection, not globally', async () => {
    await service.getHazards('conn-1');
    await service.getHazards('conn-2');
    expect(appendonlyProbeCount()).toBe(2);
  });

  it('returns no findings when the appendonly config cannot be read', async () => {
    client.getConfigValue.mockRejectedValue(new Error('ERR unknown command'));
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(0);
  });

  it('does not cache a failed CONFIG GET probe', async () => {
    client.getConfigValue.mockRejectedValue(new Error('ERR unknown command'));
    await service.getHazards('conn-1');
    await service.getHazards('conn-1');
    expect(client.getConfigValue).toHaveBeenCalledTimes(2);
  });

  it('surfaces the hazard as soon as a probe succeeds after a failure', async () => {
    client.getConfigValue.mockRejectedValueOnce(new Error('LOADING'));
    const failed = await service.getHazards('conn-1');
    expect(failed).toHaveLength(0);
    const recovered = await service.getHazards('conn-1');
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('hazard');
  });

  it('returns no findings when the connection is not registered', async () => {
    (registry.get as jest.Mock).mockImplementation(() => {
      throw new Error('Connection not found');
    });
    const findings = await service.getHazards('missing');
    expect(findings).toHaveLength(0);
  });

  it('does not cache a probe for an unregistered connection', async () => {
    (registry.get as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Connection not found');
    });
    await service.getHazards('conn-1');
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
  });

  describe('appendfsync hazard probing', () => {
    const onDefaultUser = { flags: ['on'], commands: '+@all', keys: '~*', channels: '&*' };

    function setupFsyncClient(
      opts: {
        appendfsync?: string;
        delayed?: number;
        writeStatus?: string;
        latency?: unknown;
      } = {},
    ): void {
      client.getConfigValue.mockImplementation((param: string) => {
        if (param === 'appendonly') {
          return Promise.resolve('yes');
        }
        if (param === 'appendfsync') {
          return Promise.resolve(opts.appendfsync ?? 'always');
        }
        return Promise.resolve(null);
      });
      client.call.mockImplementation((cmd: string) => {
        if (cmd === 'ACL') {
          return Promise.resolve(onDefaultUser);
        }
        if (cmd === 'INFO') {
          return Promise.resolve(
            `# Persistence\r\naof_enabled:1\r\naof_delayed_fsync:${opts.delayed ?? 0}\r\n` +
              `aof_last_write_status:${opts.writeStatus ?? 'ok'}\r\n`,
          );
        }
        if (cmd === 'LATENCY') {
          if (opts.latency instanceof Error) {
            return Promise.reject(opts.latency);
          }
          return Promise.resolve(opts.latency ?? []);
        }
        return Promise.resolve(null);
      });
    }

    it('returns the low-severity advisory for always with no symptoms', async () => {
      setupFsyncClient();
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].id).toBe('appendfsync-always-blocking');
      expect(findings[0].status).toBe('advisory');
      expect(findings[0].severity).toBe('info');
    });

    it('escalates when aof_delayed_fsync rises across consecutive probes', async () => {
      setupFsyncClient({ delayed: 5 });
      await service.getHazards('conn-1');
      now += 61_000;
      setupFsyncClient({ delayed: 9 });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('hazard');
      expect(findings[0].message).toContain('9');
    });

    it('escalates on an aof-fsync-always LATENCY event', async () => {
      setupFsyncClient({ latency: [['aof-fsync-always', 1_700_000_000, 12, 40]] });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('hazard');
      expect(findings[0].message).toContain('aof-fsync-always');
    });

    it('keeps the advisory when the LATENCY probe fails', async () => {
      setupFsyncClient({ latency: new Error('ERR unknown command') });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('advisory');
    });

    it('stays quiet for a healthy everysec', async () => {
      setupFsyncClient({ appendfsync: 'everysec' });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(0);
    });

    it('flags everysec only after two consecutive rising probes', async () => {
      setupFsyncClient({ appendfsync: 'everysec', delayed: 1 });
      await service.getHazards('conn-1');
      now += 61_000;
      setupFsyncClient({ appendfsync: 'everysec', delayed: 3 });
      const second = await service.getHazards('conn-1');
      expect(second).toHaveLength(0);
      now += 61_000;
      setupFsyncClient({ appendfsync: 'everysec', delayed: 6 });
      const third = await service.getHazards('conn-1');
      expect(third).toHaveLength(1);
      expect(third[0].id).toBe('appendfsync-everysec-backlog');
    });

    it('reports both the ACL hazard and the appendfsync advisory together', async () => {
      setupFsyncClient();
      client.call.mockImplementation((cmd: string) => {
        if (cmd === 'ACL') {
          return Promise.resolve(offDefaultUser);
        }
        if (cmd === 'INFO') {
          return Promise.resolve('# Persistence\r\naof_delayed_fsync:0\r\n');
        }
        return Promise.resolve([]);
      });
      const findings = await service.getHazards('conn-1');
      expect(findings.map((f) => f.id).sort()).toEqual([
        'appendfsync-always-blocking',
        'default-user-aof-data-loss',
      ]);
    });
  });
});
