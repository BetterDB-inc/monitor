import type Valkey from 'iovalkey';
import { Cluster } from 'iovalkey';
import { ValkeyCommandError } from './errors';

/**
 * True when the client talks to a cluster, so callers can pick a command shape
 * the cluster accepts. Multi-key commands are the usual reason to ask: a
 * cluster rejects them with CROSSSLOT unless every key hashes to one slot.
 */
export function isClusterClient(client: Valkey): boolean {
  return client instanceof Cluster;
}

function getMasterNodes(client: Valkey): Valkey[] {
  if (!(client instanceof Cluster)) return [client];
  // Cast needed: TypeScript can't narrow Valkey & Cluster because both classes
  // share a private `reconnectTimeout` field, collapsing the intersection to never.
  return (client as unknown as Cluster).nodes('master') as Valkey[];
}

/**
 * Perform a SCAN across all master nodes if the client is a Cluster instance,
 * or on the single client if standalone. Calls `onKeys` with each batch of
 * matched keys. The caller handles what to do with them (GET, DEL, etc.).
 *
 * This is the single place in the codebase that handles the cluster vs
 * standalone SCAN divergence.
 *
 * Return false from onKeys to stop scanning (remaining cursors and nodes are skipped).
 */
export async function clusterScan(
  client: Valkey,
  pattern: string,
  onKeys: (keys: string[], nodeClient: Valkey) => Promise<void | boolean> | void | boolean,
  count: number = 100,
): Promise<void> {
  const nodes = getMasterNodes(client);

  if (nodes.length === 0) {
    throw new ValkeyCommandError('SCAN', new Error('cluster has no master nodes visible'));
  }

  let stopped = false;
  for (const nodeClient of nodes) {
    if (stopped) break;
    let cursor = '0';
    do {
      let scanResult: [string, string[]];
      try {
        scanResult = await nodeClient.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      } catch (err) {
        throw new ValkeyCommandError('SCAN', err);
      }
      cursor = scanResult[0];
      const keys = scanResult[1];

      if (keys.length > 0) {
        if ((await onKeys(keys, nodeClient)) === false) {
          stopped = true;
          break;
        }
      }
    } while (cursor !== '0');
  }
}
