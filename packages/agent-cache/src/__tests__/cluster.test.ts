import { describe, it, expect, vi } from 'vitest';
import { Cluster } from 'iovalkey';
import { clusterScan } from '../cluster';
import { ValkeyCommandError } from '../errors';
import type Valkey from 'iovalkey';

// Build a mock node client that returns the given pages sequentially.
// Each element in `pages` is one SCAN result batch. The cursor loops back
// to '0' on the last page to terminate the scan loop.
function makeNodeClient(pages: string[][]): Valkey {
  let callCount = 0;
  const scan = vi.fn().mockImplementation(async () => {
    const page = pages[callCount] ?? [];
    const isLast = callCount >= pages.length - 1;
    callCount++;
    return [isLast ? '0' : `cursor-${callCount}`, page];
  });
  return { scan } as unknown as Valkey;
}

// Standalone client has no `.nodes` method — isCluster() returns false.
function makeStandaloneClient(keys: string[]): Valkey {
  return makeNodeClient([keys]);
}

// Cluster client exposes `.nodes('master')` returning per-node mock clients.
// Object.setPrototypeOf makes instanceof Cluster return true without a real connection.
function makeClusterClient(nodesPages: string[][][]): Valkey {
  const nodes = nodesPages.map((pages) => makeNodeClient(pages));
  const client = { nodes: vi.fn().mockReturnValue(nodes) };
  Object.setPrototypeOf(client, Cluster.prototype);
  return client as unknown as Valkey;
}

describe('clusterScan', () => {
  it('standalone client (no .nodes method) scans normally', async () => {
    const keys = ['key1', 'key2', 'key3'];
    const client = makeStandaloneClient(keys);

    const collected: string[] = [];
    const receivedClients: Valkey[] = [];

    await clusterScan(client, 'key*', async (batchKeys, nodeClient) => {
      collected.push(...batchKeys);
      receivedClients.push(nodeClient);
    });

    expect(collected).toEqual(keys);
    // For standalone, nodeClient IS the client itself
    expect(receivedClients).toHaveLength(1);
    expect(receivedClients[0]).toBe(client);
  });

  it('cluster client scans all master nodes', async () => {
    const node1Keys = ['key1', 'key2'];
    const node2Keys = ['key3', 'key4'];
    const node3Keys = ['key5'];

    const client = makeClusterClient([[node1Keys], [node2Keys], [node3Keys]]);

    const collected: string[] = [];

    await clusterScan(client, 'key*', async (keys) => {
      collected.push(...keys);
    });

    expect(collected).toEqual([...node1Keys, ...node2Keys, ...node3Keys]);
  });

  it('onKeys receives the correct node client, not the top-level cluster client', async () => {
    const client = makeClusterClient([[['key1']], [['key2']]]);
    // Grab node references before clusterScan runs (same mock, same objects)
    const masterNodes = (client as any).nodes('master') as Valkey[];

    const receivedClients: Valkey[] = [];

    await clusterScan(client, '*', async (keys, nodeClient) => {
      receivedClients.push(nodeClient);
    });

    expect(receivedClients).toHaveLength(2);
    expect(receivedClients[0]).toBe(masterNodes[0]);
    expect(receivedClients[1]).toBe(masterNodes[1]);
    // Must NOT be the top-level cluster client
    expect(receivedClients[0]).not.toBe(client);
    expect(receivedClients[1]).not.toBe(client);
  });

  it('empty SCAN results on some nodes do not break aggregation', async () => {
    // Node 1 has keys, node 2 is empty, node 3 has keys
    const client = makeClusterClient([[['key1', 'key2']], [[]], [['key3']]]);

    const collected: string[] = [];

    await clusterScan(client, 'key*', async (keys) => {
      collected.push(...keys);
    });

    // Empty node does not cause an error, and its keys (none) are simply skipped
    expect(collected).toEqual(['key1', 'key2', 'key3']);
  });

  it('handles multi-page SCAN on a single standalone node', async () => {
    // Two pages: first page returns cursor '1', second returns '0'
    const client = makeNodeClient([['page1-key1', 'page1-key2'], ['page2-key1']]);

    const collected: string[] = [];

    await clusterScan(client, '*', async (keys) => {
      collected.push(...keys);
    });

    expect(collected).toEqual(['page1-key1', 'page1-key2', 'page2-key1']);
  });

  it('SCAN rejection is wrapped in ValkeyCommandError', async () => {
    const client = {
      scan: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as unknown as Valkey;

    await expect(clusterScan(client, '*', async () => {}))
      .rejects.toBeInstanceOf(ValkeyCommandError);
  });

  it('onKeys throwing propagates and stops iteration on remaining nodes', async () => {
    const client = makeClusterClient([[['key1']], [['key2']], [['key3']]]);
    const visited: string[] = [];

    await expect(
      clusterScan(client, '*', async (keys) => {
        visited.push(...keys);
        if (keys.includes('key1')) throw new Error('callback error');
      }),
    ).rejects.toThrow('callback error');

    // Only node 1 was visited — nodes 2 and 3 were never reached
    expect(visited).toEqual(['key1']);
  });

  it('throws ValkeyCommandError when cluster has no master nodes', async () => {
    const client = { nodes: vi.fn().mockReturnValue([]) };
    Object.setPrototypeOf(client, Cluster.prototype);

    await expect(clusterScan(client as unknown as Valkey, '*', async () => {}))
      .rejects.toBeInstanceOf(ValkeyCommandError);
  });
});
