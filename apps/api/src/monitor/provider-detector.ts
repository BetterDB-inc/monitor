/**
 * Best-effort fingerprint of the managed Valkey/Redis provider behind a connection.
 *
 * Detection is host-based first (most reliable for managed services because the
 * vendor controls the public DNS suffix) and falls back to INFO server fields.
 * Where neither yields a hit, we report 'self-hosted' rather than 'unknown' so
 * the pre-flight UI doesn't flag every dev instance with a scary warning.
 *
 * Restrictions are advisory copy shown in the pre-flight modal; they do NOT
 * block the capture and they no longer claim a provider blocks MONITOR. The
 * authoritative answer comes from {@link MonitorSupportProbe}, which actually
 * probes the connection. The strings here are intentionally vague because
 * provider behaviour changes over time and per plan/tier.
 */

export type Provider =
  | 'aws-elasticache'
  | 'gcp-memorystore'
  | 'redis-cloud'
  | 'upstash'
  | 'self-hosted'
  | 'unknown';

export interface ProviderInfo {
  provider: Provider;
  restrictions: string[];
}

const GENERIC_MANAGED_NOTICE =
  'Not all cloud providers allow the MONITOR command on their managed instances, ' +
  'and policies change over time. If captures return no data, consult the provider ' +
  'documentation or contact us at info@betterdb.com.';

const RESTRICTIONS: Record<Provider, string[]> = {
  'aws-elasticache': [GENERIC_MANAGED_NOTICE],
  'gcp-memorystore': [GENERIC_MANAGED_NOTICE],
  'redis-cloud': [GENERIC_MANAGED_NOTICE],
  upstash: [GENERIC_MANAGED_NOTICE],
  'self-hosted': [],
  unknown: [],
};

// Ordered longest-suffix first so more specific entries (e.g. the `serverless`
// ElastiCache suffix) match before their shorter parents. matchByHost iterates
// the list and short-circuits on the first endsWith hit.
const HOST_SUFFIXES: Array<{ suffix: string; provider: Provider }> = [
  { suffix: '.internal.memorystore.googleapis.com', provider: 'gcp-memorystore' },
  { suffix: '.serverless.cache.amazonaws.com', provider: 'aws-elasticache' },
  { suffix: '.redis.cache.windows.net', provider: 'unknown' }, // Azure Cache for Redis — surface as unknown for now; restrictions unverified
  { suffix: '.gcp.cloud.rlrcp.com', provider: 'redis-cloud' },
  { suffix: '.cache.amazonaws.com', provider: 'aws-elasticache' },
  { suffix: '.redis-cloud.com', provider: 'redis-cloud' },
  { suffix: '.redislabs.com', provider: 'redis-cloud' },
  { suffix: '.upstash.io', provider: 'upstash' },
];

const PROVIDER_OVERRIDE_ALIASES: Record<string, Provider> = {
  elasticache: 'aws-elasticache',
  'aws-elasticache': 'aws-elasticache',
  memorystore: 'gcp-memorystore',
  'gcp-memorystore': 'gcp-memorystore',
  'redis-cloud': 'redis-cloud',
  rediscloud: 'redis-cloud',
  upstash: 'upstash',
  'self-hosted': 'self-hosted',
  selfhosted: 'self-hosted',
  unknown: 'unknown',
};

function readProviderOverride(): Provider | null {
  const raw = process.env.MONITOR_PROVIDER_OVERRIDE;
  if (!raw) {
    return null;
  }
  const normalised = raw.trim().toLowerCase();
  return PROVIDER_OVERRIDE_ALIASES[normalised] ?? null;
}

/**
 * @param server INFO `server` section (string keys to string values), or undefined when INFO is not yet available.
 * @param host Connection hostname; checked for managed-provider DNS suffixes first.
 */
export function detectProvider(
  server: Record<string, string | undefined> = {},
  host?: string,
): ProviderInfo {
  const override = readProviderOverride();
  if (override) {
    return { provider: override, restrictions: RESTRICTIONS[override] };
  }

  const fromHost = matchByHost(host);
  if (fromHost) {
    return { provider: fromHost, restrictions: RESTRICTIONS[fromHost] };
  }

  const fromServer = matchByServerInfo(server);
  if (fromServer) {
    return { provider: fromServer, restrictions: RESTRICTIONS[fromServer] };
  }

  // No managed-provider signal — assume self-hosted (no warnings shown).
  return { provider: 'self-hosted', restrictions: [] };
}

function matchByHost(host: string | undefined): Provider | null {
  if (!host) return null;
  const lower = host.toLowerCase();
  for (const { suffix, provider } of HOST_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return provider;
    }
  }
  return null;
}

function matchByServerInfo(server: Record<string, string | undefined>): Provider | null {
  const buildId = (server.redis_build_id ?? '').toLowerCase();
  const os = (server.os ?? '').toLowerCase();

  // Redis Cloud / Redis Enterprise builds carry "redislabs" in the build id.
  if (buildId.includes('redislabs')) return 'redis-cloud';

  // ElastiCache marks "Amazon Linux" in the OS field. Self-hosted on EC2 with
  // Amazon Linux would false-positive, but they would still get a non-blocking
  // warning, not a hard fail.
  if (os.includes('amazon')) return 'aws-elasticache';

  return null;
}
