import { readFileSync } from 'fs';
import { everestApiUrl } from './everest-client';

// Settings for the OpenEverest mode. Everything comes from the environment the
// chart sets; the BetterDB URL and token live in a Secret the backend watches,
// so a change to it is picked up without a rollout.

export interface OpenEverestConfig {
  /** Plugin CR name; the proxy path is /v1/clusters/{cluster}/plugins/{pluginName}. */
  pluginName: string;
  /** Port the plugin backend listens on; the Service in the chart points here. */
  port: number;
  /** Directory holding the frontend bundle (main.js) and icon. */
  uiDir: string;
  everestApiUrl: string;
  /** Secret in the plugin namespace with the BetterDB `url` and `token`. */
  settingsSecret: string;
  /** ConfigMap in the plugin namespace recording which instances are enabled. */
  targetsConfigMap: string;
  /** Secret in the plugin namespace the backend creates to hold the key that tags redacted secrets. */
  fingerprintSecret: string;
  /** Namespaces to watch for Instances and Secrets; empty means the whole cluster. */
  watchNamespaces: string[];
  /**
   * OpenEverest's name for the Kubernetes cluster this pod runs in. The plugin
   * only reaches instances through its own ServiceAccount, so it can only
   * monitor instances of this one cluster.
   */
  localCluster: string;
  /** PEM bundle to trust for the BetterDB WebSocket, from BETTERDB_CA_FILE. */
  cloudCa?: string;
  /** How often each instance re-runs node discovery, to follow scaling and failover. */
  rediscoverIntervalMs: number;
  /** Fallback BetterDB settings when the Secret is absent (local development). */
  fallbackSettings?: { url: string; token: string };
}

// Rediscovery below 10s would hammer every instance with CLUSTER SHARDS and
// reverse DNS; above an hour a failover goes unnoticed for too long.
export const MIN_REDISCOVER_INTERVAL_MS = 10_000;
export const MAX_REDISCOVER_INTERVAL_MS = 3_600_000;

/**
 * An integer setting from the environment, within [min, max]. A value that is
 * not an integer or out of range fails startup with a message naming the
 * variable: a silently substituted default would hide a typo in a chart value.
 */
export function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

export function loadOpenEverestConfig(env: NodeJS.ProcessEnv = process.env): OpenEverestConfig {
  const caFile = env.BETTERDB_CA_FILE;
  const watchNamespaces = (env.WATCH_NAMESPACES || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const url = env.BETTERDB_CLOUD_URL || '';
  const token = env.BETTERDB_TOKEN || '';
  return {
    pluginName: env.PLUGIN_NAME || 'betterdb',
    port: integerSetting(env, 'PORT', 8080, 1, 65535),
    uiDir: env.PLUGIN_UI_DIR || '/app/ui',
    everestApiUrl: everestApiUrl(env),
    settingsSecret: env.BETTERDB_SETTINGS_SECRET || 'betterdb-openeverest-settings',
    targetsConfigMap: env.BETTERDB_TARGETS_CONFIGMAP || 'betterdb-openeverest-targets',
    fingerprintSecret: env.BETTERDB_FINGERPRINT_SECRET || 'betterdb-openeverest-fingerprint',
    watchNamespaces,
    localCluster: env.OPENEVEREST_CLUSTER_NAME || 'main',
    cloudCa: caFile ? readFileSync(caFile, 'utf8') : undefined,
    rediscoverIntervalMs: integerSetting(env, 'BETTERDB_REDISCOVER_INTERVAL_MS', 60_000, MIN_REDISCOVER_INTERVAL_MS, MAX_REDISCOVER_INTERVAL_MS),
    fallbackSettings: url && token ? { url, token } : undefined,
  };
}
