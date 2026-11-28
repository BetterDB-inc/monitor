import { KubeApiError, KubeClient, KubeObject, sleep } from './kube-client';
import type { InstanceRef } from './everest-client';

// Which instances a user opted into, kept in a ConfigMap in the plugin's
// namespace so the choice survives pod restarts. One key per instance,
// `<cluster>/<namespace>/<instance>` (slashes are not allowed in ConfigMap
// keys, so they are stored with `.`), holding a small JSON record.

export interface TargetRecord {
  enabledAt: string;
}

interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

export function targetKey(ref: InstanceRef): string {
  return `${ref.cluster}/${ref.namespace}/${ref.instance}`;
}

// ConfigMap keys allow [-._a-zA-Z0-9]; the refs are DNS names, so only the
// separator needs mapping. Instance names can contain `.`, so use a run that
// no DNS name can.
const SEPARATOR = '__';

function toDataKey(ref: InstanceRef): string {
  return [ref.cluster, ref.namespace, ref.instance].join(SEPARATOR);
}

function fromDataKey(key: string): InstanceRef | null {
  const parts = key.split(SEPARATOR);
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  const [cluster, namespace, instance] = parts;
  return { cluster, namespace, instance };
}

// A conflict means another writer got in first, never that the change is
// wrong, so it is retried from a fresh read with a short, capped backoff.
const MAX_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 1_000;

export class TargetStore {
  private readonly path: string;
  // Every write in this process goes through one queue: the plugin runs as a
  // single pod, so its own writes (a namespace of instances deleted at once,
  // the startup prune) never race each other for the resourceVersion.
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: KubeClient,
    private readonly name: string,
    namespace = client.namespace,
  ) {
    this.path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`;
  }

  async list(): Promise<Array<{ ref: InstanceRef; record: TargetRecord }>> {
    const cm = await this.read();
    const result: Array<{ ref: InstanceRef; record: TargetRecord }> = [];
    for (const [key, value] of Object.entries(cm?.data ?? {})) {
      const ref = fromDataKey(key);
      if (!ref) continue;
      try {
        result.push({ ref, record: JSON.parse(value) as TargetRecord });
      } catch {
        result.push({ ref, record: { enabledAt: '' } });
      }
    }
    return result;
  }

  async add(ref: InstanceRef, record: TargetRecord): Promise<void> {
    await this.update((data) => ({ ...data, [toDataKey(ref)]: JSON.stringify(record) }));
  }

  async remove(ref: InstanceRef): Promise<void> {
    await this.update((data) => {
      const next = { ...data };
      delete next[toDataKey(ref)];
      return next;
    });
  }

  private async read(): Promise<ConfigMap | null> {
    try {
      return await this.client.get<ConfigMap>(`${this.path}/${encodeURIComponent(this.name)}`);
    } catch (err) {
      if (err instanceof KubeApiError && err.status === 404) return null;
      throw err;
    }
  }

  private update(mutate: (data: Record<string, string>) => Record<string, string>): Promise<void> {
    const run = this.writes.then(() => this.write(mutate), () => this.write(mutate));
    this.writes = run.catch(() => undefined);
    return run;
  }

  // Read-modify-write with the resourceVersion as the optimistic lock; a 409
  // (a writer outside this process, or a racing create) is retried from a
  // fresh read.
  private async write(mutate: (data: Record<string, string>) => Record<string, string>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.read();
      const data = mutate(current?.data ?? {});
      try {
        if (!current) {
          await this.client.post(this.path, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: this.name, labels: { 'app.kubernetes.io/managed-by': 'betterdb-openeverest' } },
            data,
          });
        } else {
          await this.client.put(`${this.path}/${encodeURIComponent(this.name)}`, { ...current, data });
        }
        return;
      } catch (err) {
        if (!(err instanceof KubeApiError && err.status === 409) || attempt >= MAX_ATTEMPTS) throw err;
        await sleep(Math.min(25 * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
  }
}
