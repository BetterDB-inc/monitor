import Valkey from 'iovalkey';
import { nodeClientAuthOptions } from './execution/client-factory';
import type { DatabaseAuthMode, TlsConfig } from '@betterdb/shared';
import {
  probeSourceFunctions,
  aggregateFunctionPresence,
  FunctionPresence,
  FunctionProbeClient,
} from './fork-compat';
import { connectWithin, NODE_CONNECT_OPTIONS, NODE_CONNECT_TIMEOUT_MS } from './node-connect';

/** The bits of a cluster node this module needs (subset of ClusterNode). */
interface ClusterNodeLike {
  flags: string[];
  slots: number[][];
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
  tlsConfig?: TlsConfig;
  authMode?: DatabaseAuthMode;
}

const UNREACHABLE_FLAGS = ['fail', 'noaddr', 'handshake'];

export function isScannableMaster(node: { flags: string[]; slots: number[][] }): boolean {
  if (node.slots.length > 0) return true;
  return !node.flags.some((flag) => UNREACHABLE_FLAGS.includes(flag));
}

/** Parse a cluster-bus address ("host:port@bus", IPv6-aware) into host/port. */
export function parseNodeAddress(address: string | undefined): { host: string; port: number } {
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
    masters = nodes.filter((n) => n.flags.includes('master') && isScannableMaster(n));
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
      // Construct inside the try: a constructor throw must resolve to 'unknown' for
      // this master, not reject Promise.all and bubble out of startExecution.
      let client: Valkey | undefined;
      try {
        client = new Valkey({
          host,
          port,
          ...nodeClientAuthOptions(config),
          ...NODE_CONNECT_OPTIONS,
          maxRetriesPerRequest: 1,
        });
        await connectWithin(client, NODE_CONNECT_TIMEOUT_MS);
        return await probeSourceFunctions(client);
      } catch {
        return 'unknown';
      } finally {
        // disconnect() tears down synchronously (sets manuallyClosing); quit() would
        // queue into the offline queue of a still-reconnecting client and hang.
        try { client?.disconnect(); } catch { /* ignore */ }
      }
    }),
  );

  return aggregateFunctionPresence(results);
}
