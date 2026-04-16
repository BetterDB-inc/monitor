import type Valkey from 'iovalkey';
import { Cluster } from 'iovalkey';
import { ValkeyCommandError } from './errors';

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
 */
export async function clusterScan(
  client: Valkey,
  pattern: string,
  onKeys: (keys: string[], nodeClient: Valkey) => Promise<void>,
  count: number = 100,
): Promise<void> {
  const nodes = getMasterNodes(client);

  for (const nodeClient of nodes) {
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
        await onKeys(keys, nodeClient);
      }
    } while (cursor !== '0');
  }
}
