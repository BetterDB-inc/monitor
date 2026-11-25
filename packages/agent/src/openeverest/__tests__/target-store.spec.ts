import { KubeApiError } from '../kube-client';
import { TargetStore, targetKey } from '../target-store';

// A ConfigMap API with optimistic locking, enough for the store's read-modify-write.
class FakeKube {
  namespace = 'plugins';
  configMap: { metadata: { name: string; resourceVersion: string }; data: Record<string, string> } | null = null;
  conflictsLeft = 0;
  puts = 0;

  async get(path: string) {
    if (!this.configMap) throw new KubeApiError(404, path, 'not found');
    return JSON.parse(JSON.stringify(this.configMap));
  }

  async post(_path: string, body: { metadata: { name: string }; data: Record<string, string> }) {
    this.configMap = { metadata: { name: body.metadata.name, resourceVersion: '1' }, data: body.data };
    return this.configMap;
  }

  async put(path: string, body: { metadata: { resourceVersion: string }; data: Record<string, string> }) {
    this.puts += 1;
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1;
      this.configMap!.metadata.resourceVersion = String(Number(this.configMap!.metadata.resourceVersion) + 1);
      throw new KubeApiError(409, path, 'conflict');
    }
    if (body.metadata.resourceVersion !== this.configMap!.metadata.resourceVersion) {
      throw new KubeApiError(409, path, 'stale resourceVersion');
    }
    this.configMap = { metadata: { ...this.configMap!.metadata, resourceVersion: String(Number(body.metadata.resourceVersion) + 1) }, data: body.data };
    return this.configMap;
  }
}

const ORDERS = { cluster: 'main', namespace: 'db', instance: 'orders.cache' };
const SESSIONS = { cluster: 'main', namespace: 'db', instance: 'sessions' };

describe('TargetStore', () => {
  it('creates the ConfigMap on the first opt-in and lists it back', async () => {
    const kube = new FakeKube();
    const store = new TargetStore(kube as never, 'betterdb-targets');

    await store.add(ORDERS, { enabledAt: '2026-11-24T00:00:00Z' });

    expect(kube.configMap?.metadata.name).toBe('betterdb-targets');
    expect(Object.keys(kube.configMap!.data)).toEqual(['main__db__orders.cache']);
    expect(await store.list()).toEqual([{ ref: ORDERS, record: { enabledAt: '2026-11-24T00:00:00Z' } }]);
  });

  it('adds and removes without touching other entries, retrying a write conflict', async () => {
    const kube = new FakeKube();
    const store = new TargetStore(kube as never, 'betterdb-targets');
    await store.add(ORDERS, { enabledAt: 'a' });
    kube.conflictsLeft = 1;

    await store.add(SESSIONS, { enabledAt: 'b' });
    await store.remove(ORDERS);

    expect((await store.list()).map((t) => t.ref.instance)).toEqual(['sessions']);
    expect(kube.puts).toBe(3);
  });

  it('lands every write when many instances are removed at once', async () => {
    const kube = new FakeKube();
    const store = new TargetStore(kube as never, 'betterdb-targets');
    const refs = Array.from({ length: 10 }, (_, i) => ({ cluster: 'main', namespace: 'db', instance: `vk${i}` }));
    for (const ref of refs) await store.add(ref, { enabledAt: 'a' });
    const putsBefore = kube.puts;

    // Fired together, as a namespace deletion or the startup prune does.
    await Promise.all(refs.map((ref) => store.remove(ref)));

    expect(await store.list()).toEqual([]);
    // Serialized in-process: one write each, no conflicts to retry.
    expect(kube.puts - putsBefore).toBe(10);
  });

  it('keeps retrying conflicts from another writer instead of giving up after a few', async () => {
    const kube = new FakeKube();
    const store = new TargetStore(kube as never, 'betterdb-targets');
    await store.add(ORDERS, { enabledAt: 'a' });
    kube.conflictsLeft = 8;

    await store.remove(ORDERS);

    expect(await store.list()).toEqual([]);
  });

  it('lists nothing when the ConfigMap does not exist yet', async () => {
    const store = new TargetStore(new FakeKube() as never, 'betterdb-targets');
    expect(await store.list()).toEqual([]);
  });
});

describe('targetKey', () => {
  it('joins cluster/namespace/instance', () => {
    expect(targetKey(ORDERS)).toBe('main/db/orders.cache');
  });
});
