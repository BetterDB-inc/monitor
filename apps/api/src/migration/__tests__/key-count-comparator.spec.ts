import Valkey, { Cluster } from 'iovalkey';
import { compareKeyCounts, countKeys } from '../validation/key-count-comparator';

function standalone(keys: number): Valkey {
  return { dbsize: jest.fn().mockResolvedValue(keys) } as unknown as Valkey;
}

function cluster(perMaster: number[]): Valkey {
  const client = Object.create(Cluster.prototype) as Cluster & { dbsize: jest.Mock };
  // A bare DBSIZE on a Cluster client hits one random node; make that visible.
  client.dbsize = jest.fn().mockResolvedValue(perMaster[0]);
  client.nodes = jest
    .fn()
    .mockReturnValue(
      perMaster.map((keys) => ({ dbsize: jest.fn().mockResolvedValue(keys) })),
    ) as unknown as Cluster['nodes'];
  return client as unknown as Valkey;
}

describe('key-count-comparator', () => {
  it('sums DBSIZE over every master of a cluster client', async () => {
    const client = cluster([1008, 988, 1004]);

    expect(await countKeys(client)).toBe(3000);
    expect((client as unknown as Cluster).nodes).toHaveBeenCalledWith('master');
  });

  it('uses DBSIZE directly for a standalone client', async () => {
    expect(await countKeys(standalone(42))).toBe(42);
  });

  it('fails loudly when a cluster client has no masters', async () => {
    await expect(countKeys(cluster([]))).rejects.toThrow('No cluster masters');
  });

  it('reports no discrepancy for a complete standalone -> cluster migration', async () => {
    const result = await compareKeyCounts(standalone(3000), cluster([1008, 988, 1004]));

    expect(result).toMatchObject({
      sourceKeys: 3000,
      targetKeys: 3000,
      discrepancy: 0,
      discrepancyPercent: 0,
    });
  });

  it('reports no discrepancy for a complete cluster -> standalone migration', async () => {
    const result = await compareKeyCounts(cluster([1008, 988, 1004]), standalone(3000));

    expect(result.discrepancyPercent).toBe(0);
  });
});
