import type { DiscoveredNode } from '@app/cluster/cluster-discovery.service';
import { readPlacementPrimaryFacts } from '../placement-primaries';

const node = (id: string, role: DiscoveredNode['role'], slots: number[][]): DiscoveredNode => ({
  id,
  address: `${id}:7000`,
  role,
  slots,
  configEpoch: 1,
  state: 'connected' as DiscoveredNode['state'],
  flags: [],
});

const valkeyInfo = { server: { valkey_version: '9.0.1', redis_version: '7.2.4' } };
const listedReply = [[['cluster|migrateslots', -4, [], 0, 0, 0]]];

describe('readPlacementPrimaryFacts', () => {
  it('reads every primary that owns slots, and no replica', async () => {
    const info = jest.fn(async () => valkeyInfo);
    const migrateSlotsInfo = jest.fn(async () => listedReply);

    const facts = await readPlacementPrimaryFacts(
      [node('a', 'master', [[0, 100]]), node('b', 'master', []), node('c', 'replica', [[0, 100]])],
      { info, migrateSlotsInfo },
    );

    expect(facts).toEqual([
      {
        address: 'a:7000',
        server: { dbType: 'valkey', version: '9.0.1' },
        migrateSlotsCommand: true,
        serverInfo: valkeyInfo.server,
      },
    ]);
    expect(info).toHaveBeenCalledWith('a');
    expect(migrateSlotsInfo).toHaveBeenCalledWith('a');
  });

  it('sends INFO and COMMAND INFO to a primary at the same time', async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = readPlacementPrimaryFacts([node('a', 'master', [[0, 1]])], {
      info: async () => {
        started.push('info');
        await gate;
        return valkeyInfo;
      },
      migrateSlotsInfo: async () => {
        started.push('command');
        await gate;
        return listedReply;
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['info', 'command']);
    release();
    await read;
  });

  it('leaves the command unknown when COMMAND INFO fails, and the server when INFO fails', async () => {
    const facts = await readPlacementPrimaryFacts([node('a', 'master', [[0, 1]])], {
      info: async () => undefined,
      migrateSlotsInfo: async () => {
        throw new Error('timed out');
      },
    });

    expect(facts).toEqual([
      { address: 'a:7000', server: null, migrateSlotsCommand: null, serverInfo: undefined },
    ]);
  });
});
