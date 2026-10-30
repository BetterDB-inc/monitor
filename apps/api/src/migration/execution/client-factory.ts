import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { buildTlsOptions, clientCredentials } from '../../database/adapters/tls-material';
import { tlsIdentityOptions } from '../../database/adapters/tls-servername';

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
 * Create a standalone Valkey client from a connection config.
 */
export function createClient(config: DatabaseConnectionConfig, name: string): Valkey {
  return new Valkey({
    host: config.host,
    port: config.port,
    ...nodeClientAuthOptions(config, config.host),
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 15_000,
    connectionName: name,
  });
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
): Valkey {
  if (!isCluster) {
    return createClient(config, name);
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

  return cluster as unknown as Valkey;
}
