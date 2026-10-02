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
    // The server-mode gate issues an INFO server read first, but the ACL GETUSER
    // probe must still be skipped when AOF is off.
    expect(client.call).not.toHaveBeenCalledWith('ACL', ['GETUSER', 'default']);
  });

  it('maps a denied ACL GETUSER to an unverified finding', async () => {
    client.call.mockRejectedValue(new Error('NOPERM'));
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('unverified');
  });

  it('flags the cluster-bus CRC hazard when cluster-crc-enabled is off', async () => {
    client.getConfigValue.mockImplementation((param: string) => {
      if (param === 'cluster-enabled') return Promise.resolve('yes');
      if (param === 'cluster-crc-enabled') return Promise.resolve('no');
      return Promise.resolve('no'); // appendonly off, so the AOF probe is skipped
    });
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('cluster-crc-disabled');
    expect(findings[0].status).toBe('advisory');
    // The server-mode gate issues an INFO server read; the AOF-only ACL GETUSER
    // probe must still be skipped when AOF is off.
    expect(client.call).not.toHaveBeenCalledWith('ACL', ['GETUSER', 'default']);
  });

  it('preserves an AOF finding when the cluster CRC read fails', async () => {
    // appendonly on (AOF hazard collected), then the cluster read is rejected.
    client.getConfigValue.mockImplementation((param: string) => {
      if (param === 'appendonly') return Promise.resolve('yes');
      return Promise.reject(new Error('ERR unknown command'));
    });
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('default-user-aof-data-loss');
  });

  it('exercises the cluster-crc-enabled read and preserves AOF findings when it fails', async () => {
    // cluster-enabled succeeds so the probe advances to cluster-crc-enabled;
    // only that second read is rejected. The AOF finding must survive and both
    // cluster reads must have been attempted.
    client.getConfigValue.mockImplementation((param: string) => {
      if (param === 'appendonly') return Promise.resolve('yes');
      if (param === 'cluster-enabled') return Promise.resolve('yes');
      if (param === 'cluster-crc-enabled') return Promise.reject(new Error('ERR unknown command'));
      return Promise.resolve('no');
    });
    const findings = await service.getHazards('conn-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('default-user-aof-data-loss');
    expect(client.getConfigValue).toHaveBeenCalledWith('cluster-enabled');
    expect(client.getConfigValue).toHaveBeenCalledWith('cluster-crc-enabled');
  });

  it('surfaces an unverified CRC finding and does not cache when cluster-enabled reads null', async () => {
    // getConfigValue resolves a filtered CONFIG GET to null WITHOUT throwing, so
    // the catch never fires; cluster mode is unknown and must not cache as clean.
    client.getConfigValue.mockImplementation((param: string) => {
      if (param === 'appendonly') return Promise.resolve('no'); // AOF off, skip that probe
      if (param === 'cluster-enabled') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const first = await service.getHazards('conn-1');
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('cluster-crc-disabled');
    expect(first[0].status).toBe('unverified');

    // Unknown cluster state is uncacheable: the next poll must re-probe.
    await service.getHazards('conn-1');
    expect(appendonlyProbeCount()).toBe(2);
  });

  it('does not cache an incomplete probe when the cluster CRC read fails', async () => {
    client.getConfigValue.mockImplementation((param: string) => {
      if (param === 'appendonly') return Promise.resolve('yes');
      if (param === 'cluster-enabled') return Promise.resolve('yes');
      if (param === 'cluster-crc-enabled') return Promise.reject(new Error('ERR unknown command'));
      return Promise.resolve('no');
    });
    await service.getHazards('conn-1');
    await service.getHazards('conn-1');
    // A failed CRC read must re-probe on the next poll rather than serving a
    // stale "clean" result from the cache.
    expect(appendonlyProbeCount()).toBe(2);
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
        // Skew of the MONITORED server's clock relative to the monitor host,
        // in seconds. LATENCY spike timestamps come from the server clock.
        serverClockSkewS?: number;
      } = {},
    ): void {
      client.getConfigValue.mockImplementation((param: string) => {
        if (param === 'appendonly') {
          return Promise.resolve('yes');
        }
        if (param === 'appendfsync') {
          return Promise.resolve(opts.appendfsync ?? 'always');
        }
        // Standalone node: cluster mode is explicitly off so the CRC probe
        // resolves cleanly rather than reading as unverified.
        if (param === 'cluster-enabled') {
          return Promise.resolve('no');
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
        if (cmd === 'TIME') {
          const serverSeconds = Math.floor(now / 1000) + (opts.serverClockSkewS ?? 0);
          return Promise.resolve([String(serverSeconds), '0']);
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

    it('does not escalate always when aof_delayed_fsync rises across probes', async () => {
      // Belt-and-braces against the engine contract: under always the counter
      // cannot rise at all, so a rise must not be treated as blocking evidence.
      setupFsyncClient({ delayed: 5 });
      await service.getHazards('conn-1');
      now += 61_000;
      setupFsyncClient({ delayed: 9 });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('advisory');
    });

    it('honours a recent spike when the server clock lags the monitor host', async () => {
      // Server an hour behind: a spike 10s ago on the SERVER reads as an
      // hour old against the host clock and would be wrongly suppressed.
      const serverClockSkewS = -3_600;
      setupFsyncClient({
        serverClockSkewS,
        latency: [['aof-fsync-always', 1_700_000_000 + serverClockSkewS - 10, 12, 40]],
      });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('hazard');
    });

    it('suppresses a stale spike when the server clock leads the monitor host', async () => {
      // Server an hour ahead: a spike an hour old on the SERVER lines up with
      // the host's "now" and would be wrongly read as current evidence.
      const serverClockSkewS = 3_600;
      setupFsyncClient({
        serverClockSkewS,
        latency: [['aof-fsync-always', 1_700_000_000, 12, 40]],
      });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('advisory');
    });

    it('escalates on a recent aof-fsync-always LATENCY event', async () => {
      setupFsyncClient({ latency: [['aof-fsync-always', 1_700_000_000, 12, 40]] });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('hazard');
      expect(findings[0].message).toContain('aof-fsync-always');
    });

    it('does not escalate on a stale LATENCY event from a long-past spike', async () => {
      // LATENCY LATEST entries persist until LATENCY RESET; a spike from an
      // hour ago is history, not evidence the main thread is blocking now.
      setupFsyncClient({ latency: [['aof-fsync-always', 1_700_000_000 - 3_600, 12, 40]] });
      const findings = await service.getHazards('conn-1');
      expect(findings).toHaveLength(1);
      expect(findings[0].status).toBe('advisory');
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

  describe('Sentinel DNS-resolution hazard', () => {
    function setupSentinel(opts: {
      resolveHostnames?: string | null;
      announceIp?: string | null;
      announceHostnames?: string | null;
      masterIp?: string;
    }): void {
      // Sentinel settings are read via SENTINEL CONFIG GET (flat [name, value] reply),
      // not the plain CONFIG GET / getConfigValue path.
      const sentinelConfig: Record<string, string | null> = {
        'resolve-hostnames': opts.resolveHostnames ?? 'yes',
        'announce-ip': opts.announceIp ?? null,
        'announce-hostnames': opts.announceHostnames ?? null,
      };
      client.call.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'INFO') {
          return Promise.resolve('# Server\r\nserver_mode:sentinel\r\n');
        }
        if (cmd === 'SENTINEL' && args[0] === 'CONFIG' && args[1] === 'GET') {
          const param = args[2];
          const value = sentinelConfig[param];
          return Promise.resolve(value != null ? [param, value] : []);
        }
        if (cmd === 'SENTINEL' && args[0] === 'MASTERS') {
          return Promise.resolve([
            [
              'name',
              'mymaster',
              'ip',
              opts.masterIp ?? 'sentinel-primary',
              'port',
              '6379',
              'flags',
              'master',
            ],
          ]);
        }
        if (cmd === 'SENTINEL' && args[0] === 'REPLICAS') {
          return Promise.resolve([]);
        }
        return Promise.resolve(null);
      });
    }

    it('flags a Sentinel with resolve-hostnames yes and a hostname monitored master', async () => {
      setupSentinel({});
      const findings = await service.getHazards('conn-sentinel');
      expect(findings).toHaveLength(1);
      expect(findings[0].id).toBe('sentinel-dns-resolution-blocking');
      expect(findings[0].status).toBe('advisory');
      // The AOF/cluster probes must never run against a Sentinel.
      expect(client.call).not.toHaveBeenCalledWith('ACL', ['GETUSER', 'default']);
      expect(client.getConfigValue).not.toHaveBeenCalledWith('appendonly');
    });

    it('stays silent for a Sentinel monitoring by IP with resolve-hostnames off', async () => {
      setupSentinel({ resolveHostnames: 'no', masterIp: '10.0.0.10' });
      const findings = await service.getHazards('conn-sentinel');
      expect(findings).toHaveLength(0);
    });

    it('does not cache an incomplete Sentinel probe when SENTINEL MASTERS fails', async () => {
      // resolve-hostnames yes but the masters read fails: the address view is
      // incomplete (a hostname target could be hidden), so the cycle must not be
      // cached as authoritative — the next poll has to re-probe.
      let masters = 0;
      client.call.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'INFO') return Promise.resolve('# Server\r\nserver_mode:sentinel\r\n');
        if (cmd === 'SENTINEL' && args[0] === 'CONFIG' && args[1] === 'GET') {
          const param = args[2];
          if (param === 'resolve-hostnames') return Promise.resolve(['resolve-hostnames', 'yes']);
          if (param === 'announce-hostnames') return Promise.resolve(['announce-hostnames', 'no']);
          return Promise.resolve([]);
        }
        if (cmd === 'SENTINEL' && args[0] === 'MASTERS') {
          masters += 1;
          return Promise.reject(new Error('LOADING Redis is loading the dataset'));
        }
        return Promise.resolve(null);
      });
      await service.getHazards('conn-sentinel');
      await service.getHazards('conn-sentinel');
      expect(masters).toBe(2);
    });
  });
});
