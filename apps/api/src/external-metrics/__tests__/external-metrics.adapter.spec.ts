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
      memory: { used_memory: '1024' },
      cpu: { used_cpu_sys: '1.5' },
      replication: { role: 'master' },
      keyspace: { db0: 'keys=3' },
    });
    expect(await adapter.getInfo(['commandstats'])).toEqual({ commandstats: { cmdstat_get: 'calls=2' } });
    expect(Object.keys(await adapter.getInfo(['everything']))).toContain('commandstats');
    expect(await adapter.getInfo(['Memory', 'latencystats'])).toEqual({ memory: { used_memory: '1024' } });
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
