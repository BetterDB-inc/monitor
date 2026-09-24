import { ExternalMetricsStore } from '../external-metrics-store';
import { ExternalMetricsAdapter } from '../external-metrics.adapter';
import { ExternalConnectionUnsupportedError } from '../external-connection-unsupported.error';
import type { FieldUpdate } from '../otlp-metrics-types';

const T0 = 1_700_000_000_000;

const scalar = (section: string, field: string, value: string): FieldUpdate => ({
  target: { kind: 'scalar', section, field },
  value,
  timeMs: T0,
});

describe('ExternalMetricsAdapter', () => {
  let store: ExternalMetricsStore;
  let now: number;
  let adapter: ExternalMetricsAdapter;

  beforeEach(() => {
    store = new ExternalMetricsStore();
    now = T0;
    adapter = new ExternalMetricsAdapter('c', store, () => now);
  });

  it('is disconnected and versionless before any sample', async () => {
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.ping()).resolves.toBe(false);
    expect(adapter.sampleVersion()).toBeNull();
    await expect(adapter.getInfo()).resolves.toEqual({});
  });

  it('connect and disconnect are no-ops', async () => {
    await expect(adapter.connect()).resolves.toBeUndefined();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it('renders INFO sections from the store', async () => {
    store.apply('c', [
      scalar('memory', 'used_memory', '1024'),
      scalar('cpu', 'used_cpu_sys', '1.5'),
      scalar('replication', 'role', 'master'),
      { target: { kind: 'composite', section: 'keyspace', field: 'db0', subkey: 'keys' }, value: '3', timeMs: T0 },
      { target: { kind: 'composite', section: 'commandstats', field: 'cmdstat_get', subkey: 'calls' }, value: '2', timeMs: T0 },
    ]);
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.sampleVersion()).not.toBeNull();
    expect(adapter.sampleVersion()).toBe(store.latestVersion('c'));
    const info = await adapter.getInfo();
    expect(info).toEqual({
      memory: { used_memory: '1024', used_memory_human: '1.00K' },
      cpu: { used_cpu_sys: '1.5' },
      replication: { role: 'master' },
      keyspace: { db0: 'keys=3' },
    });
    expect(await adapter.getInfo(['commandstats'])).toEqual({ commandstats: { cmdstat_get: 'calls=2' } });
    expect(Object.keys(await adapter.getInfo(['everything']))).toContain('commandstats');
    expect(await adapter.getInfo(['Memory', 'latencystats'])).toEqual({
      memory: { used_memory: '1024', used_memory_human: '1.00K' },
    });
  });

  it('parses into the typed INFO response', async () => {
    store.apply('c', [
      scalar('memory', 'used_memory', '2048'),
      { target: { kind: 'composite', section: 'keyspace', field: 'db0', subkey: 'keys' }, value: '7', timeMs: T0 },
    ]);
    const parsed = await adapter.getInfoParsed();
    expect(parsed.memory?.used_memory).toBe('2048');
    const db0 = parsed.keyspace?.db0;
    expect(typeof db0 === 'object' ? db0?.keys : undefined).toBe(7);
  });

  describe('presentation fields', () => {
    it('derives human-readable memory and uptime days from the pushed numbers', async () => {
      store.apply('c', [
        scalar('memory', 'used_memory', String(1024 * 1024)),
        scalar('memory', 'used_memory_peak', String(2 * 1024 * 1024)),
        scalar('memory', 'used_memory_rss', '1536'),
        scalar('server', 'uptime_in_seconds', '90000'),
      ]);
      const parsed = await adapter.getInfoParsed();
      expect(parsed.memory).toMatchObject({
        used_memory_human: '1.00M',
        used_memory_peak_human: '2.00M',
        used_memory_rss_human: '1.50K',
      });
      expect(parsed.server?.uptime_in_days).toBe('1');
      expect(await adapter.getInfo(['server'])).toEqual({
        server: { uptime_in_seconds: '90000', uptime_in_days: '1' },
      });
    });

    it.each([
      ['0', '0B'],
      ['1023', '1023B'],
      ['1024', '1.00K'],
      [String(5 * 1024 ** 3 + 512 * 1024 ** 2), '5.50G'],
      [String(3 * 1024 ** 4), '3.00T'],
      [String(2 * 1024 ** 5), '2.00P'],
    ])('formats %s bytes as %s', async (bytes, human) => {
      store.apply('c', [scalar('memory', 'used_memory', bytes)]);
      expect((await adapter.getInfo(['memory'])).memory).toEqual({ used_memory: bytes, used_memory_human: human });
    });

    it('never derives a field from an absent source', async () => {
      store.apply('c', [scalar('memory', 'used_memory', '2048'), scalar('clients', 'connected_clients', '3')]);
      const info = await adapter.getInfo();
      expect(info.memory).toEqual({ used_memory: '2048', used_memory_human: '2.00K' });
      expect(info.server).toBeUndefined();
    });

    it('leaves the server section without uptime days when uptime was not pushed', async () => {
      store.setServerVersion('c', '7.2.4');
      store.apply('c', [scalar('memory', 'used_memory', '1')]);
      expect((await adapter.getInfo(['server'])).server).toEqual({ redis_version: '7.2.4' });
    });
  });

  it('goes stale with the store window', () => {
    store.apply('c', [scalar('memory', 'used_memory', '1')]);
    now = T0 + store.staleAfterMs + 1;
    expect(adapter.isConnected()).toBe(false);
    expect(adapter.sampleVersion()).not.toBeNull();
  });

  it('reports capabilities with every feature off', () => {
    expect(adapter.getCapabilities()).toEqual({
      dbType: 'redis',
      version: 'unknown',
      hasCommandLog: false,
      hasSlotStats: false,
      hasClusterSlotStats: false,
      hasLatencyMonitor: false,
      hasAclLog: false,
      hasMemoryDoctor: false,
      hasConfig: false,
      hasVectorSearch: false,
    });
    store.setServerVersion('c', '8.0.1');
    store.markValkey('c');
    expect(adapter.getCapabilities()).toMatchObject({ dbType: 'valkey', version: '8.0.1' });
  });

  it.each([
    ['getSlowLog'],
    ['getClients'],
    ['getMemoryStats'],
    ['getConfigValue'],
    ['getClusterInfo'],
    ['getDbSize'],
    ['call'],
  ])('%s rejects with ExternalConnectionUnsupportedError', async (method) => {
    const fn = (adapter as unknown as Record<string, () => Promise<unknown>>)[method].bind(adapter);
    await expect(fn()).rejects.toBeInstanceOf(ExternalConnectionUnsupportedError);
    await expect(fn()).rejects.toMatchObject({ method });
  });

  it('getClient throws synchronously', () => {
    expect(() => adapter.getClient()).toThrow(ExternalConnectionUnsupportedError);
  });
});
