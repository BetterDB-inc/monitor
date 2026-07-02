/**
 * Product analytics module for agent-cache.
 *
 * Uses posthog-node as an optional peer dependency with a noop fallback.
 * Instance identity is a UUID persisted in Valkey.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Minimal Valkey interface — avoids importing iovalkey
export interface ValkeyLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface Analytics {
  init(client: ValkeyLike, name: string, configProps?: Record<string, unknown>): Promise<void>;
  capture(event: string, properties?: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AnalyticsOptions {
  disabled?: boolean;
}

const EVENT_PREFIX = 'agent_cache:';

// Build-time placeholders — replaced by scripts/inject-telemetry-defaults.mjs
// When the placeholder is NOT replaced, the startsWith('__') guard treats it as unset.
const BAKED_POSTHOG_API_KEY = '__BETTERDB_POSTHOG_API_KEY__';
const BAKED_POSTHOG_HOST = '__BETTERDB_POSTHOG_HOST__';

export const NOOP_ANALYTICS: Analytics = {
  async init() {},
  capture() {},
  async flush() {},
  async shutdown() {},
};

function isTelemetryOptedOut(): boolean {
  const val = process.env.BETTERDB_TELEMETRY;
  return val !== undefined && ['false', '0', 'no', 'off'].includes(val.toLowerCase());
}

const INSTALL_ID_ENV = 'BETTERDB_INSTANCE_ID';

// Holds a minted id for the rest of the process when persistence fails, so
// repeated calls (or parallel init) return one stable ephemeral identity.
let ephemeralInstallId: string | undefined;

function installIdPath(): string {
  const base = process.env.XDG_STATE_HOME;
  const root = base ? base : join(homedir(), '.betterdb');
  return join(root, 'instance_id');
}

/**
 * Stable per-install identity for product analytics. Persisted on the local
 * machine (not in Valkey), so a fleet of processes sharing one Valkey is
 * counted as many installs rather than collapsing to one. Pin it via
 * BETTERDB_INSTANCE_ID for ephemeral containers that would otherwise mint a
 * fresh id every run. Falls back to an ephemeral per-process id when no
 * writable location is available.
 */
function getInstallId(): string {
  const override = process.env[INSTALL_ID_ENV];
  if (override) return override;
  const path = installIdPath();
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // no existing id
  }
  const newId = ephemeralInstallId ?? crypto.randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, newId);
  } catch {
    // Persistence failed — hold the id for the rest of this process so
    // repeated calls return a stable ephemeral identity.
    ephemeralInstallId = newId;
  }
  return newId;
}

type PostHogClient = {
  capture: (opts: { distinctId?: string; event: string; properties?: Record<string, unknown> }) => void;
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
};

export class PostHogAnalytics implements Analytics {
  private posthog: PostHogClient;
  private distinctId = '';
  private deploymentId = '';
  // Library consumers are frequently short-lived scripts that never call
  // shutdown(), so PostHog's buffered events (flushAt=20, flushInterval=10s)
  // would be dropped when the process exits before the queue drains. Flush
  // when the event loop empties so lifecycle events are actually delivered.
  // Only enabled instances reach here — the opt-out path returns
  // NOOP_ANALYTICS and registers nothing, keeping disabled consumers silent.
  private readonly flushOnExit = (): void => {
    void this.flush();
  };

  constructor(posthog: PostHogClient) {
    this.posthog = posthog;
    process.once('beforeExit', this.flushOnExit);
  }

  async init(client: ValkeyLike, name: string, configProps?: Record<string, unknown>): Promise<void> {
    this.distinctId = getInstallId();
    this.deploymentId = await this.resolveDeploymentId(client, name);
    const merged: Record<string, unknown> = { ...(configProps ?? {}) };
    if (this.deploymentId) merged.deployment_id = this.deploymentId;
    this.capture('cache_init', merged);
    // Flush the start event immediately so it lands even for processes that exit
    // before the flush interval or the beforeExit hook fires.
    await this.flush();
  }

  private async resolveDeploymentId(client: ValkeyLike, name: string): Promise<string> {
    // The Valkey-scoped id groups all clients pointed at the same store, so a
    // shared-Valkey fleet can still be rolled up into one deployment.
    const idKey = `${name}:__instance_id`;
    try {
      const existing = await client.get(idKey);
      if (existing) return existing;
      const id = crypto.randomUUID();
      await client.set(idKey, id);
      return id;
    } catch {
      return '';
    }
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    try {
      const props: Record<string, unknown> = { ...(properties ?? {}) };
      if (this.deploymentId && props.deployment_id === undefined) {
        props.deployment_id = this.deploymentId;
      }
      this.posthog.capture({
        distinctId: this.distinctId,
        event: `${EVENT_PREFIX}${event}`,
        properties: props,
      });
    } catch {
      // never throw from analytics
    }
  }

  async flush(): Promise<void> {
    try {
      await this.posthog.flush();
    } catch {
      // swallow
    }
  }

  async shutdown(): Promise<void> {
    // Explicit shutdown supersedes the beforeExit backstop.
    process.removeListener('beforeExit', this.flushOnExit);
    try {
      await this.posthog.shutdown();
    } catch {
      // swallow
    }
  }
}

export async function createAnalytics(opts?: AnalyticsOptions): Promise<Analytics> {
  if (opts?.disabled || isTelemetryOptedOut()) {
    return NOOP_ANALYTICS;
  }

  const apiKey = BAKED_POSTHOG_API_KEY.startsWith('__') ? undefined : BAKED_POSTHOG_API_KEY;
  if (!apiKey) {
    return NOOP_ANALYTICS;
  }

  const host = BAKED_POSTHOG_HOST.startsWith('__') ? undefined : BAKED_POSTHOG_HOST;

  try {
    // @ts-ignore — posthog-node is an optional peer dep
    const { PostHog } = await import('posthog-node');
    const posthog = new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10_000 });
    return new PostHogAnalytics(posthog);
  } catch {
    // posthog-node not installed
    return NOOP_ANALYTICS;
  }
}
