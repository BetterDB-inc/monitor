import { EverestClient, InstanceRef } from './everest-client';
import { Informer, KubeApiError, KubeClient, KubeObject } from './kube-client';
import { InstanceTarget, CloudSettings, TargetStatus } from './instance-target';
import { TargetStore, targetKey } from './target-store';
import { HttpError, InstanceView, PluginBackend, SettingsView } from './plugin-server';
import type { OpenEverestConfig } from './config';
import type { SecretLike } from './connection-secret';

// Ties the OpenEverest mode together: the opt-in list (ConfigMap), the
// Instance watch, the settings Secret and one InstanceTarget per enabled
// instance. Implements the HTTP backend the plugin server calls.

interface Instance extends KubeObject {
  spec?: { providerRef?: { name?: string } };
  status?: { phase?: string; connectionSecretRef?: { name?: string } };
}

type Secret = KubeObject & SecretLike;

const INSTANCES_PATH = '/apis/core.openeverest.io/v1alpha1';
const SUPPORTED_PROVIDERS = new Set(['valkey']);

export interface TargetManagerOptions {
  config: OpenEverestConfig;
  kube: KubeClient;
  everest: EverestClient;
  log: (message: string) => void;
}

export class TargetManager implements PluginBackend {
  private readonly targets = new Map<string, InstanceTarget>();
  private readonly store: TargetStore;
  private instanceInformers: Informer<Instance>[] = [];
  private settingsInformer: Informer<Secret> | null = null;
  private settingsFromSecret: CloudSettings | null = null;
  private settingsKey = '';
  private clusterId: string | undefined;
  private started = false;

  constructor(private readonly options: TargetManagerOptions) {
    this.store = new TargetStore(options.kube, options.config.targetsConfigMap);
  }

  async start(): Promise<void> {
    const { config, kube, log } = this.options;
    this.clusterId = await this.readClusterId();
    log(`Kubernetes cluster id: ${this.clusterId ?? 'unknown (no access to the kube-system namespace)'}`);

    this.settingsInformer = new Informer<Secret>({
      client: kube,
      path: `/api/v1/namespaces/${encodeURIComponent(kube.namespace)}/secrets`,
      query: `fieldSelector=metadata.name%3D${encodeURIComponent(config.settingsSecret)}`,
      onChange: (_key, secret) => this.onSettingsSecret(secret),
      log,
    });
    this.settingsInformer.start();

    for (const { ref } of await this.store.list()) {
      this.ensureTarget(ref);
    }
    log(`${this.targets.size} instance(s) enabled from ${config.targetsConfigMap}`);

    const scopes = config.watchNamespaces.length > 0
      ? config.watchNamespaces.map((ns) => `${INSTANCES_PATH}/namespaces/${encodeURIComponent(ns)}/instances`)
      : [`${INSTANCES_PATH}/instances`];
    this.instanceInformers = scopes.map((path) => new Informer<Instance>({
      client: kube,
      path,
      onChange: (_key, instance) => this.onInstance(_key, instance),
      log,
    }));
    for (const informer of this.instanceInformers) informer.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...this.instanceInformers.map((i) => i.stop()),
      this.settingsInformer?.stop(),
      ...Array.from(this.targets.values()).map((t) => t.stop()),
    ]);
    this.targets.clear();
  }

  // --- PluginBackend ---

  async enable(ref: InstanceRef, authorization: string): Promise<InstanceView> {
    await this.authorize(ref, authorization);
    const instance = this.findInstance(ref);
    if (!instance) {
      throw new HttpError(404, `instance ${ref.namespace}/${ref.instance} is not visible to the plugin (is it in a watched namespace?)`);
    }
    const provider = instance.spec?.providerRef?.name ?? '';
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      throw new HttpError(400, `BetterDB monitors Valkey instances; this one is provided by ${provider || 'an unknown provider'}`);
    }
    await this.store.add(ref, { enabledAt: new Date().toISOString() });
    const target = this.ensureTarget(ref);
    target.setConnectionSecret(instance.status?.connectionSecretRef?.name ?? null);
    this.options.log(`enabled ${targetKey(ref)}`);
    return this.status(ref);
  }

  async disable(ref: InstanceRef, authorization: string): Promise<InstanceView> {
    await this.authorize(ref, authorization);
    await this.removeTarget(ref);
    return this.status(ref);
  }

  status(ref: InstanceRef): InstanceView {
    const target = this.targets.get(targetKey(ref));
    const status: TargetStatus = target?.status() ?? { state: 'off', secretName: null, tls: false, nodes: [] };
    return { ref, enabled: target !== undefined, status, dashboardUrl: this.settings().dashboardUrl };
  }

  settings(): SettingsView {
    const current = this.currentSettings();
    const source = this.settingsFromSecret ? 'secret' : current ? 'env' : 'none';
    return {
      url: current?.url ?? '',
      tokenSet: Boolean(current?.token),
      dashboardUrl: current ? dashboardUrlFor(current.url) : null,
      source,
      editable: this.options.config.allowSettingsEdit,
    };
  }

  async updateSettings(input: { url?: string; token?: string }, authorization: string): Promise<SettingsView> {
    const { kube, config, everest } = this.options;
    if (!config.allowSettingsEdit) {
      throw new HttpError(403, 'settings are managed by the Helm release (plugin.allowSettingsEdit is off)');
    }
    if (!(await everest.checkSession(config.localCluster, authorization))) {
      throw new HttpError(401, 'OpenEverest did not accept the session token');
    }
    const stringData: Record<string, string> = {};
    if (input.url !== undefined) stringData.url = input.url;
    if (input.token !== undefined && input.token !== '') stringData.token = input.token;
    if (Object.keys(stringData).length === 0) return this.settings();

    const path = `/api/v1/namespaces/${encodeURIComponent(kube.namespace)}/secrets`;
    try {
      await kube.mergePatch(`${path}/${encodeURIComponent(config.settingsSecret)}`, { stringData });
    } catch (err) {
      if (!(err instanceof KubeApiError) || err.status !== 404) throw err;
      await kube.post(path, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: config.settingsSecret, labels: { 'app.kubernetes.io/managed-by': 'betterdb-openeverest' } },
        type: 'Opaque',
        stringData,
      });
    }
    // The informer delivers the change; apply it now too so the response is current.
    const merged: CloudSettings = {
      url: stringData.url ?? this.currentSettings()?.url ?? '',
      token: stringData.token ?? this.currentSettings()?.token ?? '',
    };
    this.applySettings(merged.url && merged.token ? merged : null, true);
    return this.settings();
  }

  // --- internals ---

  private async authorize(ref: InstanceRef, authorization: string): Promise<void> {
    if (ref.cluster !== this.options.config.localCluster) {
      throw new HttpError(400, `this plugin runs in cluster "${this.options.config.localCluster}" and can only monitor its instances`);
    }
    const check = await this.options.everest.checkConnectionAccess(ref, authorization);
    if (!check.ok) throw new HttpError(check.status, check.reason);
  }

  private currentSettings(): CloudSettings | null {
    return this.settingsFromSecret ?? this.options.config.fallbackSettings ?? null;
  }

  private onSettingsSecret(secret: Secret | null): void {
    if (!secret) {
      this.applySettings(null, true);
      return;
    }
    const url = decodeKey(secret, 'url');
    const token = decodeKey(secret, 'token');
    this.applySettings(url && token ? { url, token } : null, true);
  }

  private applySettings(settings: CloudSettings | null, fromSecret: boolean): void {
    if (fromSecret) this.settingsFromSecret = settings;
    const effective = this.currentSettings();
    const key = effective ? `${effective.url}\n${effective.token}` : '';
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    this.options.log(effective ? `BetterDB settings: ${effective.url}` : 'BetterDB settings: not configured');
    for (const target of this.targets.values()) target.onSettingsChanged();
  }

  private ensureTarget(ref: InstanceRef): InstanceTarget {
    const key = targetKey(ref);
    let target = this.targets.get(key);
    if (!target) {
      target = new InstanceTarget({
        ref,
        kube: this.options.kube,
        settings: () => this.currentSettings(),
        clusterId: this.clusterId,
        cloudCa: this.options.config.cloudCa,
        rediscoverIntervalMs: this.options.config.rediscoverIntervalMs,
        log: this.options.log,
      });
      this.targets.set(key, target);
      const instance = this.findInstance(ref);
      if (this.started || instance) target.setConnectionSecret(instance?.status?.connectionSecretRef?.name ?? null);
    }
    return target;
  }

  private async removeTarget(ref: InstanceRef): Promise<void> {
    const key = targetKey(ref);
    const target = this.targets.get(key);
    this.targets.delete(key);
    await this.store.remove(ref);
    await target?.stop();
    if (target) this.options.log(`disabled ${key}`);
  }

  private findInstance(ref: InstanceRef): Instance | undefined {
    const key = `${ref.namespace}/${ref.instance}`;
    for (const informer of this.instanceInformers) {
      const found = informer.get(key);
      if (found) return found;
    }
    return undefined;
  }

  private onInstance(key: string, instance: Instance | null): void {
    const [namespace, name] = key.split('/');
    const ref: InstanceRef = { cluster: this.options.config.localCluster, namespace, instance: name };
    const target = this.targets.get(targetKey(ref));
    if (!target) return;
    if (!instance || instance.metadata.deletionTimestamp) {
      // The instance is going away: drop the opt-in too, so a later instance
      // with the same name starts off.
      this.options.log(`instance ${key} deleted, dropping it`);
      void this.removeTarget(ref).catch((err) => this.options.log(`dropping ${key} failed: ${(err as Error).message}`));
      return;
    }
    target.setConnectionSecret(instance.status?.connectionSecretRef?.name ?? null);
  }

  private async readClusterId(): Promise<string | undefined> {
    try {
      const ns = await this.options.kube.get<KubeObject>('/api/v1/namespaces/kube-system');
      return ns.metadata.uid;
    } catch {
      return undefined;
    }
  }
}

function decodeKey(secret: SecretLike, key: string): string {
  const plain = secret.stringData?.[key];
  if (plain !== undefined) return plain.trim();
  const encoded = secret.data?.[key];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8').trim() : '';
}

/**
 * Web URL for the BetterDB an agent URL points at: Cloud is
 * wss://<ws>.app.betterdb.com/agent/ws, self-hosted wss://<host>/api/agent/ws.
 */
export function dashboardUrlFor(agentUrl: string): string | null {
  try {
    const url = new URL(agentUrl);
    const scheme = url.protocol === 'ws:' ? 'http:' : 'https:';
    return `${scheme}//${url.host}/`;
  } catch {
    return null;
  }
}
