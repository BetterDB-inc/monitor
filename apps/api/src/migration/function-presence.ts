import Valkey from 'iovalkey';
import {
  probeSourceFunctions,
  aggregateFunctionPresence,
  FunctionPresence,
  FunctionProbeClient,
} from './fork-compat';

/** The bits of a cluster node this module needs (subset of ClusterNode). */
interface ClusterNodeLike {
  flags: string[];
  address?: string; // host:port@bus
}

/** The bits of a source adapter this module needs. */
interface ClusterProbeAdapter {
  getClient(): FunctionProbeClient;
  getClusterNodes(): Promise<ClusterNodeLike[]>;
}

/** Auth/TLS needed to open a direct connection to an individual master. */
interface ClusterProbeConfig {
  username?: string;
  password?: string;
  tls?: boolean;
}

/** Parse a cluster-bus address ("host:port@bus", IPv6-aware) into host/port. */
function parseNodeAddress(address: string | undefined): { host: string; port: number } {
  const addrPart = address?.split('@')[0] ?? '';
  const lastColon = addrPart.lastIndexOf(':');
  let host = lastColon > 0 ? addrPart.substring(0, lastColon) : '';
  const port = lastColon > 0 ? parseInt(addrPart.substring(lastColon + 1), 10) : NaN;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port };
}

/**
 * Determine whether the source holds server-side function libraries, correctly for
 * both standalone and clustered sources.
 *
 * `FUNCTION LIST` is node-local, so on a Redis Cluster a single seed-node probe can
 * miss a library that lives on another master. When the source is clustered we probe
 * every master directly and aggregate (see `aggregateFunctionPresence`); otherwise a
 * single probe of the seed connection is sufficient.
 */
export async function probeSourceFunctionsClusterAware(
  adapter: ClusterProbeAdapter,
  config: ClusterProbeConfig,
  isCluster: boolean,
): Promise<FunctionPresence> {
  if (!isCluster) {
    return probeSourceFunctions(adapter.getClient());
  }

  let masters: ClusterNodeLike[];
  try {
    const nodes = await adapter.getClusterNodes();
    masters = nodes.filter((n) => n.flags.includes('master'));
  } catch {
    return 'unknown';
  }

  // Couldn't enumerate masters — fall back to the seed rather than claim absence.
  if (masters.length === 0) {
    return probeSourceFunctions(adapter.getClient());
  }

  const results = await Promise.all(
    masters.map(async (master): Promise<FunctionPresence> => {
      const { host, port } = parseNodeAddress(master.address);
      if (!host || Number.isNaN(port)) return 'unknown';
      const client = new Valkey({
        host,
        port,
        username: config.username || undefined,
        password: config.password || undefined,
        tls: config.tls ? {} : undefined,
        lazyConnect: true,
      });
      try {
        await client.connect();
        return await probeSourceFunctions(client);
      } catch {
        return 'unknown';
      } finally {
        try { await client.quit(); } catch { /* ignore */ }
      }
    }),
  );

  return aggregateFunctionPresence(results);
}
