import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { assertUsableTlsMaterial, buildTlsOptions, clientCredentials } from '../../database/adapters/tls-material';
import { tlsIdentityOptions } from '../../database/adapters/tls-servername';

/** Receives a one-line explanation when a TLS re-read is skipped. */
export type TlsRefreshErrorHandler = (message: string) => void;

type TlsAuthConfig = Pick<DatabaseConnectionConfig, 'username' | 'password' | 'tls' | 'tlsConfig' | 'authMode'>;

/**
 * Credentials and TLS options for a per-node client built from a connection
 * config: honours certificate-only auth (no AUTH sent) and carries the custom
 * CA / client certificate so discovered nodes are reached the same way the seed is.
 * With `host`, the same SNI/hostname identity the monitor paths use is applied,
 * so a private-PKI certificate issued for a hostname verifies when the node is
 * dialled by IP. Omit it for a Cluster client, whose redisOptions apply to
 * every node and cannot carry a single servername.
 */
export function nodeClientAuthOptions(
  config: TlsAuthConfig,
  host?: string,
  announcedHostname?: string,
): { username: string | undefined; password: string | undefined; tls: ReturnType<typeof buildTlsOptions> } {
  const tls = buildTlsOptions(config);
  return {
    ...clientCredentials(config),
    tls: tls && host ? { ...tlsIdentityOptions(host, announcedHostname), ...tls } : tls,
  };
}

/**
 * Returns a function that re-reads file-sourced material on every call and
 * returns the new options, or undefined when the files are not usable. A
 * failure is reported once per distinct error, not on every call.
 */
function tlsMaterialReloader(
  config: TlsAuthConfig,
  host?: string,
  announcedHostname?: string,
  onError?: TlsRefreshErrorHandler,
): (label: string) => ReturnType<typeof buildTlsOptions> {
  let lastError: string | undefined;
  // No fingerprint check, like the adapter's reconnect refresh: a same-size
  // rewrite within one timestamp tick can leave the stat fingerprint unchanged.
  return (label) => {
    try {
      const { tls } = nodeClientAuthOptions(config, host, announcedHostname);
      if (!tls) return undefined;
      assertUsableTlsMaterial(tls);
      lastError = undefined;
      return tls;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) onError?.(`Keeping previously loaded TLS files for ${label}: ${message}`);
      lastError = message;
      return undefined;
    }
  };
}

/**
 * Re-read file-sourced TLS material before a client reconnects, so a
 * certificate rotated while a migration runs is presented on the next dial
 * (iovalkey reads `options.tls` when it opens each socket). Material that does
 * not parse as a matching pair (a rotation caught mid-write) or cannot be read
 * keeps the previously loaded options; `onError` is told why, once per
 * distinct error. Inline material never changes, so nothing is installed for it.
 */
export function attachTlsRefresh(
  client: Valkey,
  config: TlsAuthConfig,
  host?: string,
  announcedHostname?: string,
  onError?: TlsRefreshErrorHandler,
): void {
  if (!config.tls || config.tlsConfig?.source !== 'file') return;
  const reload = tlsMaterialReloader(config, host, announcedHostname, onError);
  client.on('reconnecting', () => {
    const tls = reload(`${client.options.host}:${client.options.port}`);
    if (tls) client.options.tls = tls;
  });
}

/**
 * Cluster node clients are created by iovalkey's connection pool with
 * `retryStrategy: null`: a node whose socket drops is ended and rebuilt from the
 * Cluster's `redisOptions`, so `reconnecting` never fires on a node and a
 * per-node reconnect hook would never run. Instead, each time the pool adds a
 * node (`+node`, emitted before the lazy node's first dial) the files are
 * re-read and validated, the new node is given the current material, and the
 * Cluster's `redisOptions.tls` is refreshed so every node the pool builds later
 * starts from it. Unusable or unreadable files leave both as they were.
 */
function refreshClusterNodeTls(
  cluster: Cluster,
  node: Valkey,
  reload: (label: string) => ReturnType<typeof buildTlsOptions>,
): void {
  const tls = reload(`${node.options.host}:${node.options.port}`);
  if (!tls) return;
  node.options.tls = tls;
  if (cluster.options.redisOptions) cluster.options.redisOptions.tls = tls;
}

/**
 * Create a standalone Valkey client from a connection config.
 */
export function createClient(config: DatabaseConnectionConfig, name: string, onTlsRefreshError?: TlsRefreshErrorHandler): Valkey {
  const client = new Valkey({
    host: config.host,
    port: config.port,
    ...nodeClientAuthOptions(config, config.host),
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 15_000,
    connectionName: name,
  });
  attachTlsRefresh(client, config, config.host, undefined, onTlsRefreshError);
  return client;
}

/**
 * Create a target client — Cluster or standalone depending on the topology.
 * The Cluster client is cast to Valkey so callers can use the same Commander
 * interface without branching.
 */
export function createTargetClient(
  config: DatabaseConnectionConfig,
  name: string,
  isCluster: boolean,
  onTlsRefreshError?: TlsRefreshErrorHandler,
): Valkey {
  if (!isCluster) {
    return createClient(config, name, onTlsRefreshError);
  }

  const cluster = new Cluster(
    [{ host: config.host, port: config.port }],
    {
      redisOptions: {
        ...nodeClientAuthOptions(config),
        connectTimeout: 10_000,
        commandTimeout: 15_000,
        connectionName: name,
      },
      lazyConnect: true,
      enableReadyCheck: true,
      ...(config.tls ? { dnsLookup: (address: string, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, address, 4) } : {}),
    },
  );
  // redisOptions are shared by every node, so SNI is set per node as the pool
  // adds it (a node dialled by IP gets none). Node clients never emit
  // `reconnecting` (see refreshClusterNodeTls), so changed files are re-read here too.
  if (config.tls) {
    const reload = config.tlsConfig?.source === 'file' ? tlsMaterialReloader(config, undefined, undefined, onTlsRefreshError) : undefined;
    cluster.on('+node', (node: Valkey) => {
      if (reload) refreshClusterNodeTls(cluster, node, reload);
      node.options.tls = { ...tlsIdentityOptions(node.options.host as string), ...node.options.tls };
    });
  }

  return cluster as unknown as Valkey;
}
