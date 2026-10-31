import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { assertUsableTlsMaterial, buildTlsOptions, clientCredentials } from '../../database/adapters/tls-material';
import { tlsIdentityOptions } from '../../database/adapters/tls-servername';

/** Receives a one-line explanation when a TLS re-read is skipped. */
export type TlsRefreshErrorHandler = (message: string) => void;

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
  config: Pick<DatabaseConnectionConfig, 'username' | 'password' | 'tls' | 'tlsConfig' | 'authMode'>,
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
 * Re-read file-sourced TLS material before a client reconnects, so a
 * certificate rotated while a migration runs is presented on the next dial
 * (iovalkey reads `options.tls` when it opens each socket). Material that does
 * not parse as a matching pair (a rotation caught mid-write) or cannot be read
 * keeps the previously loaded options; `onError` is told why. Inline material
 * never changes, so nothing is installed for it.
 */
export function attachTlsRefresh(
  client: Valkey,
  config: Pick<DatabaseConnectionConfig, 'username' | 'password' | 'tls' | 'tlsConfig' | 'authMode'>,
  host?: string,
  announcedHostname?: string,
  onError?: TlsRefreshErrorHandler,
): void {
  if (!config.tls || config.tlsConfig?.source !== 'file') return;
  client.on('reconnecting', () => {
    try {
      const { tls } = nodeClientAuthOptions(config, host, announcedHostname);
      if (!tls) return;
      assertUsableTlsMaterial(tls);
      client.options.tls = tls;
    } catch (error) {
      onError?.(`Keeping previously loaded TLS files for ${client.options.host}:${client.options.port}: ${error instanceof Error ? error.message : error}`);
    }
  });
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
  // Each node client copies redisOptions at creation; updating the parent later
  // would not reach it, so hook every node as the pool adds it. No host here:
  // the Cluster path carries no per-node identity options (see above).
  if (config.tls && config.tlsConfig?.source === 'file') {
    cluster.on('+node', (node: Valkey) => attachTlsRefresh(node, config, undefined, undefined, onTlsRefreshError));
  }

  return cluster as unknown as Valkey;
}
