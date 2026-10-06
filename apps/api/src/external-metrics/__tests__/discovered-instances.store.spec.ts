import {
  DISCOVERED_MAX_DISMISSALS,
  DISCOVERED_MAX_ENTRIES,
  DISCOVERED_MAX_HOST_LENGTH,
  DISCOVERED_TTL_MS,
  DiscoveredInstancesStore,
} from '../discovered-instances.store';

const T0 = 1_700_000_000_000;
const key = (host: string, port = 6379) => ({ host, port });

describe('DiscoveredInstancesStore', () => {
  it('records a new instance and reports it as new', () => {
    const store = new DiscoveredInstancesStore(true);
    expect(store.record(key('cache'), { 'service.name': 'orders' }, 3, T0)).toBe(true);
    expect(store.list(T0)).toEqual([
      { host: 'cache', port: 6379, suggestedName: 'orders', firstSeenAt: T0, lastSeenAt: T0, droppedPoints: 3 },
    ]);
  });

  it('falls back to host:port for the suggested name', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache', 7000), {}, 1, T0);
    expect(store.list(T0)[0].suggestedName).toBe('cache:7000');
  });

  it('upserts: keeps firstSeenAt, bumps lastSeenAt, accumulates points', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), {}, 2, T0);
    expect(store.record(key('CACHE'), { 'redis.version': '8.1.0' }, 5, T0 + 1000)).toBe(false);
    expect(store.list(T0 + 1000)).toEqual([
      expect.objectContaining({ host: 'cache', firstSeenAt: T0, lastSeenAt: T0 + 1000, droppedPoints: 7, version: '8.1.0' }),
    ]);
  });

  it('keeps dbSystem only for redis or valkey', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('a'), { 'db.system.name': 'valkey' }, 1, T0);
    store.record(key('b'), { 'db.system.name': 'postgresql' }, 1, T0);
    const byHost = Object.fromEntries(store.list(T0).map((i) => [i.host, i]));
    expect(byHost.a.dbSystem).toBe('valkey');
    expect(byHost.b).not.toHaveProperty('dbSystem');
  });

  it('truncates untrusted name and version', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('a'), { 'service.name': 'n'.repeat(500), 'redis.version': 'v'.repeat(100) }, 1, T0);
    const [entry] = store.list(T0);
    expect(entry.suggestedName).toHaveLength(100);
    expect(entry.version).toHaveLength(32);
  });

  it('evicts the least recently seen entry beyond the cap', () => {
    const store = new DiscoveredInstancesStore(true);
    for (let i = 0; i < DISCOVERED_MAX_ENTRIES; i += 1) store.record(key(`h${i}`), {}, 1, T0 + i);
    store.record(key('h0'), {}, 1, T0 + 10_000);
    store.record(key('new'), {}, 1, T0 + 10_001);
    const hosts = store.list(T0 + 10_001).map((i) => i.host);
    expect(hosts).toHaveLength(DISCOVERED_MAX_ENTRIES);
    expect(hosts).toContain('h0');
    expect(hosts).not.toContain('h1');
    expect(hosts[0]).toBe('new');
  });

  it('purges entries unseen for 24 h', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('old'), {}, 1, T0);
    store.record(key('fresh'), {}, 1, T0 + DISCOVERED_TTL_MS);
    expect(store.list(T0 + DISCOVERED_TTL_MS + 1).map((i) => i.host)).toEqual(['fresh']);
  });

  it('dismiss removes the entry and suppresses records for 24 h', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), {}, 1, T0);
    store.dismiss('Cache', 6379, T0);
    expect(store.list(T0)).toEqual([]);
    expect(store.record(key('cache'), {}, 1, T0 + DISCOVERED_TTL_MS - 1)).toBe(false);
    expect(store.list(T0 + DISCOVERED_TTL_MS - 1)).toEqual([]);
    expect(store.record(key('cache'), {}, 1, T0 + DISCOVERED_TTL_MS)).toBe(true);
  });

  it('forget removes the entry without dismissing it', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), {}, 1, T0);
    store.forget('CACHE', 6379);
    expect(store.list(T0)).toEqual([]);
    expect(store.record(key('cache'), {}, 1, T0 + 1)).toBe(true);
  });

  it('forgetPushed removes the entry and keeps the pushed address from reappearing', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), {}, 1, T0);
    store.forgetPushed('CACHE', 6379, T0);
    expect(store.list(T0)).toEqual([]);
    expect(store.record(key('cache'), {}, 1, T0 + 1)).toBe(false);
    expect(store.list(T0 + 1)).toEqual([]);
    expect(store.record(key('cache'), {}, 1, T0 + DISCOVERED_TTL_MS)).toBe(true);
  });

  it('forget clears a lingering dismissal', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), {}, 1, T0);
    store.dismiss('cache', 6379, T0);
    store.forget('cache', 6379);
    expect(store.record(key('cache'), {}, 1, T0 + 1)).toBe(true);
    expect(store.list(T0 + 1)).toHaveLength(1);
  });

  it('sorts by lastSeenAt descending', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('a'), {}, 1, T0);
    store.record(key('b'), {}, 1, T0 + 5);
    expect(store.list(T0 + 5).map((i) => i.host)).toEqual(['b', 'a']);
  });

  it('does not record hosts longer than the DNS maximum', () => {
    const store = new DiscoveredInstancesStore(true);
    expect(store.record(key('a'.repeat(DISCOVERED_MAX_HOST_LENGTH + 1)), {}, 1, T0)).toBe(false);
    expect(store.list(T0)).toEqual([]);
    expect(store.record(key('a'.repeat(DISCOVERED_MAX_HOST_LENGTH)), {}, 1, T0)).toBe(true);
    expect(store.list(T0)).toHaveLength(1);
  });

  it('keeps previously seen dbSystem and version when a later push omits them', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), { 'db.system.name': 'valkey', 'redis.version': '8.1.0' }, 1, T0);
    store.record(key('cache'), {}, 1, T0 + 1);
    expect(store.list(T0 + 1)[0]).toEqual(expect.objectContaining({ dbSystem: 'valkey', version: '8.1.0' }));
  });

  it('caps the host:port fallback name at the registration limit', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('h'.repeat(DISCOVERED_MAX_HOST_LENGTH)), {}, 1, T0);
    expect(store.list(T0)[0].suggestedName).toHaveLength(100);
  });

  it('keeps the suggested name when a later push omits service.name', () => {
    const store = new DiscoveredInstancesStore(true);
    store.record(key('cache'), { 'service.name': 'orders' }, 1, T0);
    store.record(key('cache'), {}, 1, T0 + 1);
    expect(store.list(T0 + 1)[0].suggestedName).toBe('orders');
  });

  it('refuses new dismissals beyond the cap but still refreshes existing ones', () => {
    const store = new DiscoveredInstancesStore(true);
    for (let i = 0; i < DISCOVERED_MAX_DISMISSALS; i += 1) {
      expect(store.dismiss(`h${i}`, 6379, T0)).toBe(true);
    }
    expect(store.dismiss('overflow', 6379, T0)).toBe(false);
    expect(store.record(key('overflow'), {}, 1, T0)).toBe(true);
    expect(store.dismiss('H0', 6379, T0 + 1)).toBe(true);
  });

  it('frees dismissal slots once they expire', () => {
    const store = new DiscoveredInstancesStore(true);
    for (let i = 0; i < DISCOVERED_MAX_DISMISSALS; i += 1) store.dismiss(`h${i}`, 6379, T0);
    expect(store.dismiss('late', 6379, T0 + DISCOVERED_TTL_MS)).toBe(true);
  });
});
