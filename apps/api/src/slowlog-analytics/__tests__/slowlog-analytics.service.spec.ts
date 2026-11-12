import { Test, TestingModule } from '@nestjs/testing';
import { SlowLogAnalyticsService } from '../slowlog-analytics.service';
import { StoragePort, StoredSlowLogEntry } from '../../common/interfaces/storage-port.interface';
import { SlowLogEntry } from '../../common/interfaces/database-port.interface';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { SettingsService } from '../../settings/settings.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('SlowLogAnalyticsService', () => {
  let service: SlowLogAnalyticsService;
  let storageClient: jest.Mocked<StoragePort>;

  beforeEach(async () => {
    storageClient = {
      pruneOldSlowLogEntries: jest.fn().mockResolvedValue(5),
      getLatestSlowLogId: jest.fn().mockResolvedValue(null),
    } as any;

    const connectionRegistry = {
      getDefaultId: jest.fn().mockReturnValue('default-conn'),
      getAll: jest.fn().mockReturnValue([]),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    const settingsService = {
      getCachedSettings: jest.fn().mockReturnValue({ anomalyPollIntervalMs: 30000 }),
    } as any;

    const runtimeCapabilityTracker = {
      isAvailable: jest.fn().mockReturnValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlowLogAnalyticsService,
        { provide: 'STORAGE_CLIENT', useValue: storageClient },
        { provide: ConnectionRegistry, useValue: connectionRegistry },
        { provide: SettingsService, useValue: settingsService },
        { provide: RuntimeCapabilityTracker, useValue: runtimeCapabilityTracker },
      ],
    }).compile();

    service = module.get<SlowLogAnalyticsService>(SlowLogAnalyticsService);
  });

  describe('pruneOldEntries', () => {
    it('should call storage with 7-day cutoff', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(7);

      expect(storageClient.pruneOldSlowLogEntries).toHaveBeenCalledTimes(1);
      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should call storage with 30-day cutoff', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries(30);

      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 30 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should default to 7 days when no argument is provided', async () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);

      await service.pruneOldEntries();

      const cutoff = storageClient.pruneOldSlowLogEntries.mock.calls[0][0];
      expect(cutoff).toBeCloseTo(NOW - 7 * MS_PER_DAY, -3);

      jest.restoreAllMocks();
    });

    it('should pass connectionId through to storage', async () => {
      await service.pruneOldEntries(7, 'myconnection');

      expect(storageClient.pruneOldSlowLogEntries).toHaveBeenCalledWith(
        expect.any(Number),
        'myconnection',
      );
    });

    it('should return the count from storage', async () => {
      storageClient.pruneOldSlowLogEntries.mockResolvedValue(42);

      const result = await service.pruneOldEntries(7);

      expect(result).toBe(42);
    });
  });
});

describe('SlowLogAnalyticsService external entry counts', () => {
  const ENV_KEYS = [
    'ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS',
    'ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES',
    'ANOMALY_SLOWLOG_IGNORE_COMMANDS',
  ] as const;
  const saved: StoredSlowLogEntry[] = [];
  let service: SlowLogAnalyticsService;
  let served: SlowLogEntry[];

  function entry(id: number, clientName: string, command: string[] = ['GET', 'k']): SlowLogEntry {
    return {
      id,
      timestamp: 1_700_000_000 + id,
      duration: 20_000,
      command,
      clientAddress: '10.0.0.8:1',
      clientName,
    };
  }

  function buildService(): SlowLogAnalyticsService {
    const storage = {
      saveSlowLogEntries: jest.fn(async (entries: StoredSlowLogEntry[]) => {
        saved.push(...entries);
        return entries.length;
      }),
      getLatestSlowLogId: jest.fn(async () => 10),
      hasRunIdLogEntries: async () => false,
    };
    const registry = {
      getDefaultId: () => 'conn-1',
      getAll: () => [],
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const capabilities = { isAvailable: () => true, recordFailure: () => false };
    return new SlowLogAnalyticsService(
      registry as never,
      storage as never,
      {} as never,
      capabilities as never,
    );
  }

  async function poll(): Promise<void> {
    await (service as unknown as { pollConnection(ctx: unknown): Promise<void> }).pollConnection({
      connectionId: 'conn-1',
      connectionName: 'Primary',
      host: '10.0.0.1',
      port: 6379,
      client: {
        getSlowLog: jest.fn(async () => served),
        getServingEndpoint: () => ({ host: '10.0.0.1', port: 6379 }),
        getConnectionGeneration: () => 1,
        getInfo: async () => ({ server: { run_id: 'run-a' } }),
      },
    });
  }

  beforeEach(() => {
    saved.length = 0;
    for (const key of ENV_KEYS) delete process.env[key];
    service = buildService();
    served = [
      entry(11, 'BetterDB-Monitor'),
      entry(12, 'BetterDB-Monitor-Node-ab'),
      entry(13, 'app'),
      entry(14, 'BetterDB-Monitor'),
      entry(15, 'app'),
    ];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('counts only external entries and still stores every new row', async () => {
    await poll();

    expect(service.getLastSeenId('conn-1')).toBe(15);
    expect(service.getExternalEntryCount('conn-1')).toBe(2);
    expect(saved.map((row) => row.id)).toEqual([11, 12, 13, 14, 15]);
  });

  it('counts own clients when ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS is false', async () => {
    process.env.ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS = 'false';
    service = buildService();

    await poll();

    expect(service.getExternalEntryCount('conn-1')).toBe(5);
  });

  it('ignores client-name prefixes from ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES', async () => {
    process.env.ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES = 'valkey-operator';
    service = buildService();
    served = [entry(11, 'valkey-operator'), entry(12, 'valkey-operator-node'), entry(13, 'app')];

    await poll();

    expect(service.getExternalEntryCount('conn-1')).toBe(1);
    expect(saved).toHaveLength(3);
  });

  it('ignores commands listed in ANOMALY_SLOWLOG_IGNORE_COMMANDS', async () => {
    process.env.ANOMALY_SLOWLOG_IGNORE_COMMANDS = 'cluster|slot-stats,latency|histogram';
    service = buildService();
    served = [
      entry(11, 'app', ['CLUSTER', 'SLOT-STATS', 'ORDERBY', 'key-count']),
      entry(12, 'app', ['LATENCY', 'HISTOGRAM']),
      entry(13, 'app', ['GET', 'user:1']),
    ];

    await poll();

    expect(service.getExternalEntryCount('conn-1')).toBe(1);
    expect(saved).toHaveLength(3);
  });

  it('matches a command-only entry whatever its arguments, and a subcommand entry only for that subcommand', async () => {
    process.env.ANOMALY_SLOWLOG_IGNORE_COMMANDS = 'get,cluster|slot-stats';
    service = buildService();
    served = [
      entry(11, 'app', ['GET', 'user:1']),
      entry(12, 'app', ['GET', 'user:2']),
      entry(13, 'app', ['CLUSTER', 'SLOT-STATS', 'ORDERBY', 'key-count']),
      entry(14, 'app', ['CLUSTER', 'NODES']),
      entry(15, 'app', ['SET', 'k', 'v']),
    ];

    await poll();

    expect(service.getExternalEntryCount('conn-1')).toBe(2);
  });

  it('counts entries logged but not read, from the id gap, except on the first poll', async () => {
    // Stored id is 10 and the log is at 1015: that gap is from before this
    // process polled, so only the entries read are counted.
    served = [entry(1014, 'BetterDB-Monitor'), entry(1015, 'app')];
    await poll();
    expect(service.getExternalEntryCount('conn-1')).toBe(1);

    // 400 entries were logged since id 1015; only the newest 128 can be read.
    served = Array.from({ length: 128 }, (_, i) =>
      entry(1288 + i, i < 3 ? 'BetterDB-Monitor' : 'app'),
    );
    await poll();

    expect(service.getLastSeenId('conn-1')).toBe(1415);
    // 1 from the first poll + 125 read from `app` + 272 never read.
    expect(service.getExternalEntryCount('conn-1')).toBe(398);
  });
});
