/**
 * Best-effort fingerprint of the managed Valkey/Redis provider behind a connection.
 *
 * Detection is host-based first (most reliable for managed services because the
 * vendor controls the public DNS suffix) and falls back to INFO server fields.
 * Where neither yields a hit, we report 'self-hosted' rather than 'unknown' so
 * the pre-flight UI doesn't flag every dev instance with a scary warning.
 *
 * Restrictions are documentation strings shown in the pre-flight modal; they do
 * NOT block the capture. Capture-time enforcement happens server-side via ACL.
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

const RESTRICTIONS: Record<Provider, string[]> = {
  'aws-elasticache': [
    'ElastiCache may rate-limit or terminate MONITOR sessions after a per-account quota.',
    'IAM auth is unaffected; the +monitor ACL must still be granted to the cache user.',
  ],
  'gcp-memorystore': [
    'Memorystore Standard tier disables MONITOR. Use a Customer-Managed Redis instance for diagnostic captures.',
  ],
  'redis-cloud': [
    'Redis Cloud Essentials and Fixed plans disable MONITOR. Pro / Enterprise plans allow it on a best-effort basis.',
  ],
  upstash: [
    'Upstash REST tier does not support MONITOR. Direct-Redis tier supports it but charges per-command, including MONITOR-streamed commands.',
  ],
  'self-hosted': [],
  unknown: [],
};

const HOST_SUFFIXES: Array<{ suffix: string; provider: Provider }> = [
  { suffix: '.cache.amazonaws.com', provider: 'aws-elasticache' },
  { suffix: '.serverless.cache.amazonaws.com', provider: 'aws-elasticache' },
  { suffix: '.gcp.cloud.rlrcp.com', provider: 'redis-cloud' },
  { suffix: '.redislabs.com', provider: 'redis-cloud' },
  { suffix: '.redis-cloud.com', provider: 'redis-cloud' },
  { suffix: '.redis.cache.windows.net', provider: 'unknown' }, // Azure Cache for Redis — surface as unknown for now; restrictions unverified
  { suffix: '.upstash.io', provider: 'upstash' },
  { suffix: '.internal.memorystore.googleapis.com', provider: 'gcp-memorystore' },
];

/**
 * @param server INFO `server` section (string keys to string values), or undefined when INFO is not yet available.
 * @param host Connection hostname; checked for managed-provider DNS suffixes first.
 */
export function detectProvider(
  server: Record<string, string | undefined> = {},
  host?: string,
): ProviderInfo {
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
