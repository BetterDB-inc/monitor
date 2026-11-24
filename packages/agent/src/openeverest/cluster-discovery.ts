// Finds the nodes behind an OpenEverest Valkey instance. provider-valkey always
// runs cluster-enabled, so the seed address (the headless or primary Service)
// is asked for CLUSTER SHARDS (CLUSTER NODES on servers without it) and the
// agent then opens one connection per node, by IP, with no redirect handling:
// each node is monitored as itself, the way the Monitor already treats
// directly-connected cluster members.

export interface DiscoveredNode {
  /**
   * Stable key for the node: the cluster node id, which survives pod restarts
   * because it lives in nodes.conf on the node's volume. `host:port` for a
   * standalone server.
   */
  id: string;
  host: string;
  port: number;
  role: 'primary' | 'replica';
  /** The node's own hostname when it announces one (cluster-announce-hostname). */
  hostname?: string;
}

/** The subset of a Valkey client discovery needs. */
export interface DiscoveryClient {
  call(command: string, ...args: string[]): Promise<unknown>;
}

export interface DiscoveryOptions {
  /** Whether the seed connection uses TLS: picks `tls-port` or `port` from CLUSTER SHARDS. */
  tls: boolean;
}

export async function discoverNodes(
  client: DiscoveryClient,
  seed: { host: string; port: number },
  options: DiscoveryOptions = { tls: false },
): Promise<DiscoveredNode[]> {
  // cluster_enabled lives in INFO's cluster section (CLUSTER INFO has
  // cluster_state and the like, never cluster_enabled). CLUSTER INFO itself is
  // the fallback: it errors on a standalone server ("This instance has
  // cluster support disabled") and answers on a cluster node.
  let clusterEnabled = false;
  try {
    clusterEnabled = /cluster_enabled:1/.test(String(await client.call('INFO', 'cluster')));
  } catch {
    try {
      await client.call('CLUSTER', 'INFO');
      clusterEnabled = true;
    } catch {
      clusterEnabled = false;
    }
  }
  if (!clusterEnabled) {
    return [{ id: `${seed.host}:${seed.port}`, host: seed.host, port: seed.port, role: 'primary' }];
  }

  let nodes: DiscoveredNode[] = [];
  try {
    nodes = parseClusterShards(await client.call('CLUSTER', 'SHARDS'), options);
  } catch {
    nodes = parseClusterNodes(String(await client.call('CLUSTER', 'NODES')));
  }
  if (nodes.length === 0) {
    throw new Error('CLUSTER SHARDS returned no reachable nodes');
  }
  return dedupe(nodes);
}

/**
 * CLUSTER SHARDS (Valkey 7+): an array of shards, each a flat key/value list
 * with a `nodes` entry that is itself an array of flat key/value lists. A node
 * reports both `port` and `tls-port` (0 for the one it does not serve); the
 * one matching the connection's TLS setting is used, the other as fallback.
 * Nodes that report `health` other than `online` are left out.
 */
export function parseClusterShards(raw: unknown, options: DiscoveryOptions = { tls: false }): DiscoveredNode[] {
  if (!Array.isArray(raw)) throw new Error('unexpected CLUSTER SHARDS reply');
  const nodes: DiscoveredNode[] = [];
  for (const shard of raw) {
    const fields = toMap(shard);
    const members = fields.get('nodes');
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const node = toMap(member);
      const id = String(node.get('id') ?? '');
      const port = options.tls
        ? Number(node.get('tls-port') || node.get('port'))
        : Number(node.get('port') || node.get('tls-port'));
      const health = node.get('health');
      const endpoint = str(node.get('endpoint'));
      const ip = str(node.get('ip'));
      // `endpoint` is what clients should dial; it is "?" when unknown. The
      // ip is the fallback for nodes announcing only a hostname.
      const host = endpoint && endpoint !== '?' ? endpoint : ip;
      if (!id || !host || !Number.isInteger(port) || port <= 0) continue;
      if (health !== undefined && String(health) !== 'online') continue;
      nodes.push({
        id,
        host,
        port,
        role: String(node.get('role')) === 'master' ? 'primary' : 'replica',
        hostname: str(node.get('hostname')) || undefined,
      });
    }
  }
  return nodes;
}

/**
 * CLUSTER NODES: one line per node, `<id> <ip:port@cport[,hostname]> <flags> ...`.
 * Nodes flagged fail, noaddr or handshake are left out.
 */
export function parseClusterNodes(raw: string): DiscoveredNode[] {
  const nodes: DiscoveredNode[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [id, address, flags] = parts;
    const flagSet = new Set(flags.split(','));
    if (flagSet.has('fail') || flagSet.has('fail?') || flagSet.has('noaddr') || flagSet.has('handshake')) continue;
    const [hostPortWithHostname] = address.split('@');
    const [hostPort, hostname] = address.includes(',') ? [hostPortWithHostname, address.split(',')[1]] : [hostPortWithHostname, undefined];
    const colon = hostPort.lastIndexOf(':');
    if (colon === -1) continue;
    const host = hostPort.slice(0, colon);
    const port = parseInt(hostPort.slice(colon + 1), 10);
    if (!host || !Number.isInteger(port) || port <= 0) continue;
    nodes.push({
      id,
      host,
      port,
      role: flagSet.has('master') ? 'primary' : 'replica',
      hostname: hostname || undefined,
    });
  }
  return nodes;
}

function dedupe(nodes: DiscoveredNode[]): DiscoveredNode[] {
  const byId = new Map<string, DiscoveredNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function toMap(flat: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(flat)) return map;
  for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), flat[i + 1]);
  return map;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}
