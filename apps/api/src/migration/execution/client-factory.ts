import Valkey, { Cluster } from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';

/**
 * Create a standalone Valkey client from a connection config.
 */
export function createClient(config: DatabaseConnectionConfig, name: string): Valkey {
  return new Valkey({
    host: config.host,
    port: config.port,
    username: config.username || undefined,
    password: config.password || undefined,
    tls: config.tls ? {} : undefined,
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
        username: config.username || undefined,
        password: config.password || undefined,
        tls: config.tls ? {} : undefined,
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
