// Exercises the manager against a fake Kubernetes API (Instances, Secrets,
// the opt-in ConfigMap) and a fake OpenEverest. InstanceTarget is replaced by
// a stub: it is the orchestration that is under test here, not the agents.

const mockTargets: FakeTarget[] = [];

class FakeTarget {
  secret: string | null | undefined;
  stopped = false;
  settingsChanges = 0;

  constructor(readonly options: { ref: { cluster: string; namespace: string; instance: string }; clusterId?: string }) {
    mockTargets.push(this);
  }

  get ref() {
    return this.options.ref;
  }

  setConnectionSecret(name: string | null): void {
    this.secret = name;
  }

  onSettingsChanged(): void {
    this.settingsChanges += 1;
  }

  status() {
    return { state: this.stopped ? 'off' : 'connecting', secretName: this.secret ?? null, tls: false, nodes: [] };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

jest.mock('../instance-target', () => ({ InstanceTarget: FakeTarget }));

import { KubeApiError } from '../kube-client';
import { TargetManager } from '../target-manager';
import type { OpenEverestConfig } from '../config';

type Obj = { metadata: { name: string; namespace?: string; resourceVersion?: string; uid?: string; deletionTimestamp?: string }; [k: string]: unknown };

// Enough of the Kubernetes API for the manager: list, watch (held open until
// abort, events pushed by the test), get/post/put for the ConfigMap and the
// kube-system namespace, mergePatch for the settings Secret.
class FakeKube {
  namespace = 'everest-system';
  objects = new Map<string, Obj[]>();
  configMap: Obj | null = null;
  kubeSystem: { uid?: string; failWith?: number | 'network'; failTimes?: number } = { uid: 'cluster-uid' };
  watchers = new Map<string, Array<(e: { type: string; object: Obj }) => void>>();
  patches: Array<{ path: string; body: unknown }> = [];
  removeFails = 0;

  private collection(path: string): string {
    return path.split('?')[0];
  }

  async get(path: string) {
    if (path === '/api/v1/namespaces/kube-system') {
      // failTimes bounds the failures; without it they never stop.
      const { failWith, failTimes } = this.kubeSystem;
      if (failWith !== undefined && (failTimes === undefined || failTimes > 0)) {
        if (failTimes !== undefined) this.kubeSystem.failTimes = failTimes - 1;
        if (failWith === 'network') throw new Error('ECONNRESET');
        throw new KubeApiError(failWith, path, 'fail');
      }
      return { metadata: { name: 'kube-system', uid: this.kubeSystem.uid } };
    }
    if (path.endsWith('/configmaps/targets')) {
      if (!this.configMap) throw new KubeApiError(404, path, 'not found');
      return JSON.parse(JSON.stringify(this.configMap));
    }
    const items = this.objects.get(this.collection(path)) ?? [];
    const selector = /fieldSelector=metadata.name%3D([^&]+)/.exec(path);
    const filtered = selector ? items.filter((o) => o.metadata.name === decodeURIComponent(selector[1])) : items;
    return { metadata: { resourceVersion: '1' }, items: filtered };
  }

  async post(path: string, body: Obj) {
    if (path.endsWith('/configmaps')) {
      this.configMap = { ...body, metadata: { ...body.metadata, resourceVersion: '1' } };
      return this.configMap;
    }
    const items = this.objects.get(this.collection(path)) ?? [];
    items.push(body);
    this.objects.set(this.collection(path), items);
    return body;
  }

  async put(path: string, body: Obj) {
    if (this.removeFails > 0 && Object.keys((body.data as Record<string, string>) ?? {}).length < Object.keys((this.configMap?.data as Record<string, string>) ?? {}).length) {
      this.removeFails -= 1;
      throw new KubeApiError(500, path, 'etcd unavailable');
    }
    this.configMap = { ...body, metadata: { ...body.metadata, resourceVersion: String(Number(body.metadata.resourceVersion ?? '1') + 1) } };
    return this.configMap;
  }

  async mergePatch(path: string, body: unknown) {
    this.patches.push({ path, body });
    return body;
  }

  watch(path: string, _rv: string | undefined, onEvent: (e: { type: string; object: Obj }) => void, signal: AbortSignal): Promise<void> {
    const key = this.collection(path);
    const list = this.watchers.get(key) ?? [];
    list.push(onEvent);
    this.watchers.set(key, list);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  emit(path: string, type: 'ADDED' | 'MODIFIED' | 'DELETED', object: Obj): void {
    for (const fn of this.watchers.get(path) ?? []) fn({ type, object });
  }

  enabledKeys(): string[] {
    return Object.keys((this.configMap?.data as Record<string, string>) ?? {});
  }
}

const INSTANCES = '/apis/core.openeverest.io/v1alpha1/instances';
const SECRETS = '/api/v1/namespaces/everest-system/secrets';

function instance(namespace: string, name: string, secret = `${name}-conn`): Obj {
  return {
    metadata: { name, namespace, resourceVersion: '1' },
    spec: { providerRef: { name: 'valkey' } },
    status: { phase: 'Provisioned', connectionSecretRef: { name: secret } },
  };
}

function config(overrides: Partial<OpenEverestConfig> = {}): OpenEverestConfig {
  return {
    pluginName: 'betterdb',
    port: 8080,
    uiDir: '/ui',
    everestApiUrl: 'http://everest',
    settingsSecret: 'settings',
    targetsConfigMap: 'targets',
    watchNamespaces: [],
    localCluster: 'main',
    rediscoverIntervalMs: 60_000,
    ...overrides,
  };
}

function build(kube: FakeKube, overrides: Partial<OpenEverestConfig> = {}, everestStatus = 200) {
  const everest = {
    checkConnectionAccess: jest.fn(async () => (everestStatus === 200 ? { ok: true } : { ok: false, status: everestStatus, reason: `status ${everestStatus}` })),
  };
  const logs: string[] = [];
  const manager = new TargetManager({ config: config(overrides), kube: kube as never, everest: everest as never, log: (m) => logs.push(m), maxBackoffMs: 1 });
  return { manager, everest, logs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ORDERS = { cluster: 'main', namespace: 'db', instance: 'orders' };

beforeEach(() => {
  mockTargets.length = 0;
});

describe('TargetManager opt-ins', () => {
  it('prunes opt-ins whose Instance no longer exists once the informers have listed', async () => {
    const kube = new FakeKube();
    kube.objects.set(INSTANCES, [instance('db', 'orders')]);
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}', main__db__gone: '{}' } };
    const { manager, logs } = build(kube);

    await manager.start();
    await flush();

    expect(manager.status(ORDERS).enabled).toBe(true);
    expect(manager.status({ ...ORDERS, instance: 'gone' }).enabled).toBe(false);
    expect(kube.enabledKeys()).toEqual(['main__db__orders']);
    expect(logs.some((l) => l.includes('main/db/gone no longer exists'))).toBe(true);
    await manager.stop();
  });

  it('drops the opt-in when the Instance is deleted while enabled', async () => {
    const kube = new FakeKube();
    kube.objects.set(INSTANCES, [instance('db', 'orders')]);
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager } = build(kube);
    await manager.start();
    await flush();
    const target = mockTargets[0];
    expect(target.secret).toBe('orders-conn');

    kube.emit(INSTANCES, 'DELETED', instance('db', 'orders'));
    await flush();

    expect(target.stopped).toBe(true);
    expect(kube.enabledKeys()).toEqual([]);
    expect(manager.status(ORDERS).enabled).toBe(false);
    await manager.stop();
  });

  it('stops the agents and keeps the map and ConfigMap consistent when the ConfigMap write fails', async () => {
    const kube = new FakeKube();
    kube.objects.set(INSTANCES, [instance('db', 'orders')]);
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager } = build(kube);
    await manager.start();
    await flush();
    const first = mockTargets[0];
    kube.removeFails = 1;

    await expect(manager.disable(ORDERS, 'Bearer x')).rejects.toThrow('etcd unavailable');

    expect(first.stopped).toBe(true);
    expect(manager.status(ORDERS).enabled).toBe(true);
    expect(kube.enabledKeys()).toEqual(['main__db__orders']);
    expect(mockTargets).toHaveLength(2);
    expect(mockTargets[1].stopped).toBe(false);

    await manager.disable(ORDERS, 'Bearer x');
    expect(manager.status(ORDERS).enabled).toBe(false);
    expect(kube.enabledKeys()).toEqual([]);
    await manager.stop();
  });

  it('lets an opt-in be disabled when the instance is gone and /connection answers 404, once the informers have listed', async () => {
    const kube = new FakeKube();
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager, everest } = build(kube, {}, 404);
    // Before start(): nothing listed yet, so "gone" cannot be trusted.
    await expect(manager.disable(ORDERS, 'Bearer x')).rejects.toMatchObject({ status: 503 });
    expect(kube.enabledKeys()).toEqual(['main__db__orders']);

    await manager.start();
    // The initial list prunes the orphan on its own; re-add an opt-in to disable by hand.
    await flush();
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '9' }, data: { main__db__orders: '{}' } };
    const view = await manager.disable(ORDERS, 'Bearer x');

    expect(view.enabled).toBe(false);
    expect(kube.enabledKeys()).toEqual([]);
    expect(everest.checkConnectionAccess).toHaveBeenCalled();
    await manager.stop();
  });

  it('does not take a 404 as "gone" for a namespace it does not watch', async () => {
    const kube = new FakeKube();
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: {} };
    const { manager } = build(kube, { watchNamespaces: ['databases'] }, 404);
    await manager.start();
    await flush();

    await expect(manager.disable({ cluster: 'main', namespace: 'elsewhere', instance: 'x' }, 'Bearer x')).rejects.toMatchObject({ status: 404 });
    await manager.stop();
  });

  it('still refuses to disable a present instance when the check fails', async () => {
    const kube = new FakeKube();
    kube.objects.set(INSTANCES, [instance('db', 'orders')]);
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager } = build(kube, {}, 403);
    await manager.start();
    await flush();

    await expect(manager.disable(ORDERS, 'Bearer x')).rejects.toMatchObject({ status: 403 });
    expect(manager.status(ORDERS).enabled).toBe(true);
    await manager.stop();
  });
});

describe('TargetManager cluster id', () => {
  it('retries transient failures and starts targets only once the id is known', async () => {
    const kube = new FakeKube();
    kube.kubeSystem = { uid: 'cluster-uid', failWith: 'network', failTimes: 2 };
    kube.objects.set(INSTANCES, [instance('db', 'orders')]);
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager, logs } = build(kube);

    await manager.start();

    expect(mockTargets[0].options.clusterId).toBe('cluster-uid');
    expect(logs.filter((l) => l.includes('retrying')).length).toBe(2);
    await manager.stop();
  });

  it('falls back loudly to the cluster name when kube-system is forbidden', async () => {
    const kube = new FakeKube();
    kube.kubeSystem = { failWith: 403 };
    kube.configMap = { metadata: { name: 'targets', resourceVersion: '1' }, data: { main__db__orders: '{}' } };
    const { manager, logs } = build(kube);

    await manager.start();

    expect(mockTargets[0].options.clusterId).toBeUndefined();
    expect(logs.some((l) => l.startsWith('WARNING') && l.includes('403'))).toBe(true);
    await manager.stop();
  });
});

describe('TargetManager settings', () => {
  it('treats a Secret without a token as inheriting the environment token', async () => {
    const kube = new FakeKube();
    kube.objects.set(SECRETS, [{ metadata: { name: 'settings', namespace: 'everest-system', resourceVersion: '1' }, stringData: { url: 'wss://from-secret/agent/ws' } }]);
    const { manager } = build(kube, { fallbackSettings: { url: 'wss://env/agent/ws', token: 'env-token' } });

    await manager.start();
    await flush();

    expect(manager.settings()).toMatchObject({ url: 'wss://from-secret/agent/ws', tokenSet: true, source: 'secret' });
    await manager.stop();
  });
});
