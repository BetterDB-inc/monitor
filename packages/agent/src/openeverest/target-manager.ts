import { EverestClient, InstanceRef } from './everest-client';
import { Informer, KubeApiError, KubeClient, KubeObject, sleep } from './kube-client';
import { InstanceTarget, CloudSettings, TargetStatus } from './instance-target';
import { TargetStore, targetKey } from './target-store';
import { HttpError, InstanceView, PluginBackend, SettingsView } from './plugin-server';
import type { OpenEverestConfig } from './config';
import { decodeSecretValue, SecretLike } from './connection-secret';

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
// Reading the kube-system UID: transient failures are retried for about two
// minutes before falling back to the cluster name, which changes every
// connection id, so that fallback is loud.
const CLUSTER_ID_ATTEMPTS = 8;
const CLUSTER_ID_MAX_BACKOFF_MS = 30_000;

export interface TargetManagerOptions {
  config: OpenEverestConfig;
  kube: KubeClient;
  everest: EverestClient;
  log: (message: string) => void;
  /** Backoff ceiling for retries (tests shorten it). */
  maxBackoffMs?: number;
}

export class TargetManager implements PluginBackend {
  private readonly targets = new Map<string, InstanceTarget>();
  private readonly store: TargetStore;
  private instanceInformers: Informer<Instance>[] = [];
  private readonly syncedInformers = new Set<Informer<Instance>>();
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
    // Node agents carry the cluster id in their identity, so nothing starts
    // before it is known (or known to be unavailable).
    this.clusterId = await this.readClusterId();
    log(`Kubernetes cluster id: ${this.clusterId ?? 'unavailable'}`);

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
    this.instanceInformers = scopes.map((path) => {
      const informer: Informer<Instance> = new Informer<Instance>({
        client: kube,
        path,
        onChange: (key, instance) => this.onInstance(key, instance),
        onSynced: () => this.onInstancesSynced(informer),
        log,
      });
      return informer;
    });
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
    this.ensureTarget(ref);
    this.options.log(`enabled ${targetKey(ref)}`);
    return this.status(ref);
  }

  async disable(ref: InstanceRef, authorization: string): Promise<InstanceView> {
    // An instance that is already gone answers 404 on /connection; its opt-in
    // must still be removable. "Gone" can only be trusted once the instance
    // informers have listed and the namespace is one they cover.
    const missing = !this.findInstance(ref);
    const trusted = this.instancesSynced() && this.namespaceWatched(ref.namespace);
    await this.authorize(ref, authorization, { allowMissing: missing && trusted, notReady: missing && !this.instancesSynced() });
    await this.removeTarget(ref);
    return this.status(ref);
  }

  private instancesSynced(): boolean {
    return this.instanceInformers.length > 0 && this.syncedInformers.size === this.instanceInformers.length;
  }

  private namespaceWatched(namespace: string): boolean {
    const { watchNamespaces } = this.options.config;
    return watchNamespaces.length === 0 || watchNamespaces.includes(namespace);
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
    };
  }

  // --- internals ---

  private async authorize(
    ref: InstanceRef,
    authorization: string,
    options: { allowMissing?: boolean; notReady?: boolean } = {},
  ): Promise<void> {
    if (ref.cluster !== this.options.config.localCluster) {
      throw new HttpError(400, `this plugin runs in cluster "${this.options.config.localCluster}" and can only monitor its instances`);
    }
    const check = await this.options.everest.checkConnectionAccess(ref, authorization);
    if (check.ok) return;
    if (check.status === 404 && options.allowMissing) return;
    if (check.status === 404 && options.notReady) {
      throw new HttpError(503, 'the plugin has not finished listing instances yet, retry shortly');
    }
    throw new HttpError(check.status, check.reason);
  }

  private currentSettings(): CloudSettings | null {
    return this.settingsFromSecret ?? this.options.config.fallbackSettings ?? null;
  }

  private onSettingsSecret(secret: Secret | null): void {
    if (!secret) {
      this.applySettings(null, true);
      return;
    }
    // A Secret without a token inherits the environment's.
    const fallback = this.options.config.fallbackSettings;
    const url = decodeSecretValue(secret, 'url')?.trim() || fallback?.url || '';
    const token = decodeSecretValue(secret, 'token')?.trim() || fallback?.token || '';
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

  /**
   * Stops the target and drops its opt-in. The agents are always stopped;
   * if the ConfigMap write then fails the target is put back, so the map
   * and the ConfigMap never disagree about what is enabled.
   */
  private async removeTarget(ref: InstanceRef): Promise<void> {
    const key = targetKey(ref);
    const target = this.targets.get(key);
    this.targets.delete(key);
    await target?.stop();
    try {
      await this.store.remove(ref);
    } catch (err) {
      if (target) this.ensureTarget(ref);
      throw err;
    }
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

  // Once every instance informer has listed, opt-ins whose Instance no
  // longer exists (deleted while the plugin was down) are dropped; the
  // informer alone only reports changes to instances it can see.
  private onInstancesSynced(informer: Informer<Instance>): void {
    this.syncedInformers.add(informer);
    if (this.syncedInformers.size < this.instanceInformers.length) return;
    for (const target of Array.from(this.targets.values())) {
      if (this.findInstance(target.ref)) continue;
      const key = targetKey(target.ref);
      this.options.log(`instance ${key} no longer exists, dropping its opt-in`);
      void this.removeTarget(target.ref).catch((err) => this.options.log(`dropping ${key} failed: ${(err as Error).message}`));
    }
  }

  private async readClusterId(): Promise<string | undefined> {
    const { kube, log } = this.options;
    for (let attempt = 1; ; attempt++) {
      try {
        const ns = await kube.get<KubeObject>('/api/v1/namespaces/kube-system');
        return ns.metadata.uid;
      } catch (err) {
        const status = err instanceof KubeApiError ? err.status : 0;
        if (status === 401 || status === 403 || status === 404) {
          log(`WARNING: cannot read the kube-system namespace (${status}); connection ids will be keyed on the ` +
            `OpenEverest cluster name "${this.options.config.localCluster}" instead of the cluster UID`);
          return undefined;
        }
        if (attempt >= CLUSTER_ID_ATTEMPTS) {
          log(`WARNING: reading the kube-system namespace kept failing (${(err as Error).message}); connection ids will be ` +
            `keyed on the OpenEverest cluster name "${this.options.config.localCluster}" until the next restart`);
          return undefined;
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), this.options.maxBackoffMs ?? CLUSTER_ID_MAX_BACKOFF_MS);
        log(`reading the kube-system namespace failed (${(err as Error).message}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
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
