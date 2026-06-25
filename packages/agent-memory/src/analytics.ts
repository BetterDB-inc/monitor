/**
 * Product analytics module for agent-memory.
 *
 * Uses posthog-node with a noop fallback when it is unavailable or telemetry
 * is opted out. Instance identity is a UUID persisted in Valkey via the
 * memory store's command client.
 *
 * Opt out by setting BETTERDB_TELEMETRY=false (or 0 / no / off).
 */

// Minimal command-client surface — matches MemoryStoreClient.
export interface AnalyticsClient {
  call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown>;
}

export interface Analytics {
  init(client: AnalyticsClient, name: string, configProps?: Record<string, unknown>): Promise<void>;
  capture(event: string, properties?: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

export interface AnalyticsOptions {
  apiKey?: string;
  host?: string;
  disabled?: boolean;
}

const EVENT_PREFIX = 'agent_memory:';

// Build-time placeholders — replaced by scripts/inject-telemetry-defaults.mjs.
// When the placeholder is NOT replaced, the startsWith('__') guard treats it as unset.
const BAKED_POSTHOG_API_KEY = '__BETTERDB_POSTHOG_API_KEY__';
const BAKED_POSTHOG_HOST = '__BETTERDB_POSTHOG_HOST__';

export const NOOP_ANALYTICS: Analytics = {
  async init() {},
  capture() {},
  async shutdown() {},
};

function isTelemetryOptedOut(): boolean {
  const val = process.env.BETTERDB_TELEMETRY;
  return val !== undefined && ['false', '0', 'no', 'off'].includes(val.toLowerCase());
}

class PostHogAnalytics implements Analytics {
  private posthog: { capture: (opts: { distinctId?: string; event: string; properties?: Record<string, unknown> }) => void; shutdown: () => Promise<void> };
  private distinctId = '';

  constructor(posthog: { capture: (opts: { distinctId?: string; event: string; properties?: Record<string, unknown> }) => void; shutdown: () => Promise<void> }) {
    this.posthog = posthog;
  }

  async init(client: AnalyticsClient, name: string, configProps?: Record<string, unknown>): Promise<void> {
    const idKey = `${name}:__instance_id`;
    try {
      const existing = await client.call('GET', idKey);
      if (existing) {
        this.distinctId = existing instanceof Buffer ? existing.toString() : String(existing);
      } else {
        const id = crypto.randomUUID();
        await client.call('SET', idKey, id);
        this.distinctId = id;
      }
    } catch {
      this.distinctId = crypto.randomUUID();
    }
    this.capture('memory_init', configProps);
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    try {
      this.posthog.capture({
        distinctId: this.distinctId,
        event: `${EVENT_PREFIX}${event}`,
        properties,
      });
    } catch {
      // never throw from analytics
    }
  }

  async shutdown(): Promise<void> {
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

  const apiKey =
    opts?.apiKey ??
    (BAKED_POSTHOG_API_KEY.startsWith('__') ? undefined : BAKED_POSTHOG_API_KEY);
  if (!apiKey) {
    return NOOP_ANALYTICS;
  }

  const host =
    opts?.host ??
    (BAKED_POSTHOG_HOST.startsWith('__') ? undefined : BAKED_POSTHOG_HOST);

  try {
    // @ts-ignore — posthog-node is resolved at runtime
    const { PostHog } = await import('posthog-node');
    const posthog = new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10_000 });
    return new PostHogAnalytics(posthog);
  } catch {
    // posthog-node not installed
    return NOOP_ANALYTICS;
  }
}
