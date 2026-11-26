import type { DatabaseConnectionConfig, TopologyMembership } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  ClusterIdentityService,
  clusterStateSignature,
  followerSignature,
  outageSignature,
  promotionSignature,
  recoverySightingSignature,
} from './cluster-identity.service';

const SEED = 'seed';
const NOW = 1_700_000_000_000;
const MINUTE_MS = 60_000;

const view = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));

const memberOf = (
  seedId: string,
  origin: TopologyMembership['origin'] = 'auto',
): Partial<DatabaseConnectionConfig> => ({
  membership: { seedId, nodeId: 'n', origin, source: 'cluster' },
});

describe('ClusterIdentityService', () => {
  let configs: Record<string, Partial<DatabaseConnectionConfig>>;
  let connected: Set<string>;
  let removalListeners: Array<(id: string) => void>;
  let service: ClusterIdentityService;

  beforeEach(() => {
    configs = { [SEED]: {}, 'member-1': memberOf(SEED), 'member-2': memberOf(SEED), manual: {} };
    connected = new Set(Object.keys(configs));
    removalListeners = [];
    const registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      list: jest.fn(() =>
        Object.entries(configs).map(([id, config]) => ({
          id,
          host: `${id}.internal`,
          port: 6379,
          membership: config.membership,
        })),
      ),
      get: jest.fn((id: string) => {
        if (!(id in configs)) throw new Error(`Connection '${id}' not found`);
        return { isConnected: () => connected.has(id) };
      }),
      addConnectionRemovalListener: jest.fn((listener: (id: string) => void) => {
        removalListeners.push(listener);
        return () => {
          removalListeners = removalListeners.filter((kept) => kept !== listener);
        };
      }),
    } as unknown as ConnectionRegistry;
    service = new ClusterIdentityService(registry);
    service.onModuleInit();
  });

  describe('cluster key', () => {
    it('is the same for two connections whose views share a node', () => {
      service.observe('member-1', view('a', 'b', 'c'));
      service.observe('manual', view('c', 'd'));

      expect(service.clusterKeyOf('manual')).toBe(service.clusterKeyOf('member-1'));
    });

    it('differs between connections whose views share no node', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('x', 'y'));

      expect(service.clusterKeyOf('manual')).not.toBe(service.clusterKeyOf('member-1'));
    });

    it('stays the same while the nodes of the cluster are replaced one by one', () => {
      service.observe('member-1', view('a', 'b'));
      const key = service.clusterKeyOf('member-1');

      service.observe('member-1', view('b', 'c'));
      service.observe('member-1', view('c', 'd'));

      expect(service.clusterKeyOf('member-1')).toBe(key);
    });

    it('keeps the last key when a view comes back empty', () => {
      service.observe('member-1', view('a', 'b'));
      const key = service.clusterKeyOf('member-1');

      service.observe('member-1', []);

      expect(service.clusterKeyOf('member-1')).toBe(key);
    });

    it.each(['fail', 'fail?', 'noaddr', 'handshake'])(
      'is not shared with a cluster that only lists one of its nodes as %s',
      (flag) => {
        service.observe('member-1', [...view('a', 'b'), { id: 'moved', flags: ['master', flag] }]);
        service.observe('manual', view('moved', 'z'));

        expect(service.clusterKeyOf('manual')).not.toBe(service.clusterKeyOf('member-1'));
      },
    );

    it('keeps the last key when every node in the view is failed', () => {
      service.observe('member-1', view('a', 'b'));
      const key = service.clusterKeyOf('member-1');

      service.observe('member-1', [{ id: 'z', flags: ['master', 'fail'] }]);

      expect(service.clusterKeyOf('member-1')).toBe(key);
    });

    it('settles on one key when two clusters that were read apart are joined', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('d', 'c'));

      for (let poll = 0; poll < 2; poll++) {
        service.observe('member-1', view('a', 'b', 'c'));
        service.observe('manual', view('d', 'c'));
      }

      expect(service.clusterKeyOf('manual')).toBe(service.clusterKeyOf('member-1'));
    });

    it('moves every connection of two joined clusters to one key without a new read', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(service.clusterKeyOf('member-1')).toBe(service.clusterKeyOf(SEED));
      expect(service.clusterKeyOf('manual')).toBe(service.clusterKeyOf(SEED));
    });

    it('keeps a third cluster on its own key when two others are joined', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      service.observe('member-2', view('x', 'y'));
      const apart = service.clusterKeyOf('member-2');

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(service.clusterKeyOf('member-2')).toBe(apart);
      expect(service.clusterKeyOf(SEED)).not.toBe(apart);
    });

    it('is its own for a node that lists only itself after it left the cluster', () => {
      service.observe(SEED, view('a', 'b', 'c'));
      service.observe('member-1', view('a', 'b', 'c'));

      service.observe('member-1', view('c'));

      expect(service.clusterKeyOf('member-1')).not.toBe(service.clusterKeyOf(SEED));
    });

    it('is shared by two connections to a node that lists only itself', () => {
      service.observe('manual', view('c'));
      service.observe('member-1', view('c'));

      expect(service.clusterKeyOf('member-1')).toBe(service.clusterKeyOf('manual'));
    });

    it('stays the key of the cluster for a node that lists the others as failing', () => {
      service.observe(SEED, view('a', 'b', 'c'));
      service.observe('member-1', view('a', 'b', 'c'));

      service.observe('member-1', [
        { id: 'c' },
        { id: 'a', flags: ['master', 'fail?'] },
        { id: 'b', flags: ['slave', 'fail?'] },
      ]);

      expect(service.clusterKeyOf('member-1')).toBe(service.clusterKeyOf(SEED));
    });

    it('is the key of the cluster again once a node that listed only itself joined it', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('z'));

      service.observe('member-1', view('z', 'a', 'b'));

      expect(service.clusterKeyOf('member-1')).toBe(service.clusterKeyOf(SEED));
    });

    it('is the seed id for a member and its seed before either has read a view', () => {
      expect(service.clusterKeyOf('member-1')).toBe(SEED);
      expect(service.clusterKeyOf(SEED)).toBe(SEED);
    });

    it('is the key of the seed for a member that has not read a view yet', () => {
      service.observe(SEED, view('a', 'b'));

      expect(service.clusterKeyOf('member-1')).toBe(service.clusterKeyOf(SEED));
    });

    it('is the connection id for a connection without a seed and without a view', () => {
      expect(service.clusterKeyOf('manual')).toBe('manual');
    });

    it('is forgotten when the connection is removed', () => {
      service.observe('manual', view('a', 'b'));

      removalListeners.forEach((listener) => listener('manual'));

      expect(service.clusterKeyOf('manual')).toBe('manual');
    });

    it('is not handed to an unrelated cluster that reuses a node id after every viewer left', () => {
      service.observe('member-1', view('a', 'b'));
      const key = service.clusterKeyOf('member-1');
      removalListeners.forEach((listener) => listener('member-1'));

      service.observe('manual', view('a', 'z'));

      expect(service.clusterKeyOf('manual')).not.toBe(key);
    });

    it('stops listening for removed connections when the module is destroyed', () => {
      service.onModuleDestroy();

      expect(removalListeners).toHaveLength(0);
    });
  });

  describe('failover claim', () => {
    it('is given once per signature in a cluster', () => {
      const signature = promotionSignature('node-b', 7);

      expect(service.claimFailover('cluster-1', signature, NOW)).toBe(true);
      expect(service.claimFailover('cluster-1', signature, NOW + 1_000)).toBe(false);
    });

    it('is given again for the same signature in another cluster', () => {
      const signature = promotionSignature('node-b', 7);
      service.claimFailover('cluster-1', signature, NOW);

      expect(service.claimFailover('cluster-2', signature, NOW)).toBe(true);
    });

    it('is given again when the same node is promoted at a later epoch', () => {
      service.claimFailover('cluster-1', promotionSignature('node-b', 7), NOW);

      expect(service.claimFailover('cluster-1', promotionSignature('node-b', 9), NOW)).toBe(true);
    });

    it('is not given for a node following a reported promotion after the epoch moved', () => {
      service.claimFailover('cluster-1', promotionSignature('node-b', 7), NOW);

      expect(service.claimFailover('cluster-1', followerSignature('node-b', 9), NOW)).toBe(false);
    });

    it('is not given for a promotion seen at an older epoch than the reported one', () => {
      service.claimFailover('cluster-1', promotionSignature('node-b', 9), NOW);

      expect(service.claimFailover('cluster-1', promotionSignature('node-b', 7), NOW)).toBe(false);
    });

    it('is given for a node following a primary whose promotion nobody reported', () => {
      expect(service.claimFailover('cluster-1', followerSignature('node-b', 7), NOW)).toBe(true);
      expect(service.claimFailover('cluster-1', promotionSignature('node-b', 7), NOW)).toBe(false);
    });

    it('is given for a later promotion of a primary that was first seen through a follower', () => {
      service.claimFailover('cluster-1', followerSignature('node-b', 7), NOW);

      expect(service.claimFailover('cluster-1', promotionSignature('node-b', 9), NOW)).toBe(true);
    });

    it('holds a promotion for ten minutes', () => {
      const signature = promotionSignature('node-b', 7);
      service.claimFailover('cluster-1', signature, NOW);

      expect(service.claimFailover('cluster-1', signature, NOW + 10 * MINUTE_MS - 1)).toBe(false);
      expect(service.claimFailover('cluster-1', signature, NOW + 10 * MINUTE_MS)).toBe(true);
    });

    it.each([
      ['an outage', outageSignature()],
      ['a recovery', clusterStateSignature('ok')],
    ])('holds %s for one minute', (_name, signature) => {
      service.claimFailover('cluster-1', signature, NOW);

      expect(service.claimFailover('cluster-1', signature, NOW + MINUTE_MS - 1)).toBe(false);
      expect(service.claimFailover('cluster-1', signature, NOW + MINUTE_MS)).toBe(true);
    });

    it('treats a state failure and new slot failures as one outage', () => {
      service.claimFailover('cluster-1', clusterStateSignature('fail'), NOW);

      expect(service.claimFailover('cluster-1', outageSignature(), NOW)).toBe(false);
    });

    it('treats a failure and the recovery from it as two changes', () => {
      service.claimFailover('cluster-1', clusterStateSignature('fail'), NOW);

      expect(service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW)).toBe(true);
    });

    it('is given for a second outage to a poller that saw the reported recovery', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 10_000);

      expect(
        service.claimFailover('cluster-1', outageSignature(), NOW + 30_000, NOW + 10_000),
      ).toBe(true);
    });

    it('holds the second outage again once it was reported', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 10_000);
      service.claimFailover('cluster-1', outageSignature(), NOW + 30_000, NOW + 10_000);

      expect(
        service.claimFailover('cluster-1', outageSignature(), NOW + 31_000, NOW + 11_000),
      ).toBe(false);
    });

    it.each([
      ['whose state last changed before the recovery was reported', NOW - MINUTE_MS],
      ['that never saw the state change', undefined],
    ])('is not given for the late failure of a poller %s', (_name, changedAt) => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 10_000);

      expect(service.claimFailover('cluster-1', outageSignature(), NOW + 12_000, changedAt)).toBe(
        false,
      );
    });

    it('reports one outage and one recovery when a second node sees both late', () => {
      const reported = [
        service.claimFailover('cluster-1', outageSignature(), NOW),
        service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 5_000, NOW),
        service.claimFailover('cluster-1', outageSignature(), NOW + 6_000),
        service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 8_000, NOW + 6_000),
      ];

      expect(reported).toEqual([true, true, false, false]);
    });

    it('is given to any poller once the hold of the recovered outage has passed', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 10_000);

      expect(service.claimFailover('cluster-1', outageSignature(), NOW + MINUTE_MS)).toBe(true);
    });

    it('is given for a second recovery to a poller that saw the reported outage', () => {
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW);
      service.claimFailover('cluster-1', outageSignature(), NOW + 10_000);

      expect(
        service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 30_000, NOW + 10_000),
      ).toBe(true);
    });

    it('is not given for the late recovery of a poller that failed before the reported outage', () => {
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW);
      service.claimFailover('cluster-1', outageSignature(), NOW + 10_000);

      expect(
        service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 12_000, NOW - 5_000),
      ).toBe(false);
    });

    it('stays held when the cluster it was made in is joined with another', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      service.claimFailover(service.clusterKeyOf('member-1'), promotionSignature('a', 7), NOW);
      service.claimFailover(service.clusterKeyOf('manual'), promotionSignature('c', 7), NOW);

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      const joined = service.clusterKeyOf(SEED);
      expect(service.claimFailover(joined, promotionSignature('a', 7), NOW + 1_000)).toBe(false);
      expect(service.claimFailover(joined, promotionSignature('c', 7), NOW + 1_000)).toBe(false);
    });

    it('stays held for the longer time when both joined clusters made it', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      const [early, late] = [service.clusterKeyOf('member-1'), service.clusterKeyOf('manual')];
      service.claimFailover(early, outageSignature(), NOW);
      service.claimFailover(late, outageSignature(), NOW + 30_000);

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(service.clusterKeyOf(SEED), outageSignature(), NOW + 70_000),
      ).toBe(false);
    });

    it('keeps the later epoch when the joined cluster held an earlier one for longer', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      service.claimFailover(service.clusterKeyOf('member-1'), promotionSignature('a', 9), NOW);
      service.claimFailover(
        service.clusterKeyOf('manual'),
        followerSignature('a', 7),
        NOW + 30_000,
      );

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(service.clusterKeyOf(SEED), promotionSignature('a', 9), NOW + 60_000),
      ).toBe(false);
    });

    it('stays reported when the joined cluster only sighted the recovery', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      service.claimFailover(service.clusterKeyOf('member-1'), clusterStateSignature('ok'), NOW);
      service.claimFailover(
        service.clusterKeyOf('manual'),
        recoverySightingSignature(),
        NOW + 30_000,
      );

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(
          service.clusterKeyOf(SEED),
          clusterStateSignature('ok'),
          NOW + 31_000,
        ),
      ).toBe(false);
    });

    it('is given for a second outage after a join when the shorter hold saw the recovery', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      const [first, second] = [service.clusterKeyOf('member-1'), service.clusterKeyOf('manual')];
      service.claimFailover(first, outageSignature(), NOW);
      service.claimFailover(second, outageSignature(), NOW + 5_000);
      service.claimFailover(first, recoverySightingSignature(), NOW + 10_000, NOW);

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(
          service.clusterKeyOf(SEED),
          outageSignature(),
          NOW + 30_000,
          NOW + 10_000,
        ),
      ).toBe(true);
    });

    it('stays held after a join when the other cluster claimed it after the recovery', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      const [first, second] = [service.clusterKeyOf('member-1'), service.clusterKeyOf('manual')];
      service.claimFailover(first, outageSignature(), NOW);
      service.claimFailover(first, recoverySightingSignature(), NOW + 10_000, NOW);
      service.claimFailover(second, outageSignature(), NOW + 15_000);

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(
          service.clusterKeyOf(SEED),
          outageSignature(),
          NOW + 30_000,
          NOW + 10_000,
        ),
      ).toBe(false);
    });

    it.each([
      ['the first two', ['a', 'b', 'c', 'd']],
      ['the last two', ['c', 'd', 'e', 'f']],
    ])(
      'is given after the recovery that followed three claims when %s are joined first',
      (_order, firstJoin) => {
        service.observe('member-1', view('a', 'b'));
        service.observe('member-2', view('c', 'd'));
        service.observe('manual', view('e', 'f'));
        const [first, second, third] = ['member-1', 'member-2', 'manual'].map((id) =>
          service.clusterKeyOf(id),
        );
        service.claimFailover(first, outageSignature(), NOW);
        service.claimFailover(second, outageSignature(), NOW + 5_000);
        service.claimFailover(first, recoverySightingSignature(), NOW + 10_000, NOW);
        service.claimFailover(third, outageSignature(), NOW + 15_000);
        service.claimFailover(second, recoverySightingSignature(), NOW + 20_000, NOW + 5_000);

        service.observe(SEED, view(...firstJoin));
        service.observe(SEED, view('a', 'b', 'c', 'd', 'e', 'f'));

        expect(
          service.claimFailover(
            service.clusterKeyOf(SEED),
            outageSignature(),
            NOW + 30_000,
            NOW + 20_000,
          ),
        ).toBe(true);
      },
    );

    it('counts a reported sighting from when it was sighted when clusters are joined', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('c', 'd'));
      const [first, second] = [service.clusterKeyOf('member-1'), service.clusterKeyOf('manual')];
      service.claimFailover(second, recoverySightingSignature(), NOW + 9_000);
      service.claimFailover(first, recoverySightingSignature(), NOW + 10_000);
      service.claimFailover(second, outageSignature(), NOW + 10_500);
      service.claimFailover(first, clusterStateSignature('ok'), NOW + 11_000);

      service.observe(SEED, view('a', 'b', 'c', 'd'));

      expect(
        service.claimFailover(
          service.clusterKeyOf(SEED),
          clusterStateSignature('ok'),
          NOW + 13_000,
          NOW + 12_000,
        ),
      ).toBe(true);
    });

    it('is given once for a recovery that is sighted and not reported', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);

      expect(service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 10_000)).toBe(
        true,
      );
      expect(service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 11_000)).toBe(
        false,
      );
    });

    it('is given for a second outage to a poller that sighted the recovery', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 10_000, NOW);

      expect(
        service.claimFailover('cluster-1', outageSignature(), NOW + 30_000, NOW + 10_000),
      ).toBe(true);
    });

    it('is given once to a reporter for a recovery that was only sighted', () => {
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW);

      expect(service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 500)).toBe(true);
      expect(service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 900)).toBe(
        false,
      );
    });

    it('is given for a second outage to a poller whose sighting was then reported', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 10_000, NOW);
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 11_000);

      expect(
        service.claimFailover('cluster-1', outageSignature(), NOW + 30_000, NOW + 10_000),
      ).toBe(true);
    });

    it('is not given as a sighting of a recovery that was reported', () => {
      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW);

      expect(service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 500)).toBe(
        false,
      );
    });

    it('is not given to a reporter for a sighted recovery once a new outage was reported', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 10_000, NOW);
      service.claimFailover('cluster-1', outageSignature(), NOW + 12_000, NOW + 10_000);

      expect(
        service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 12_500, NOW + 1_000),
      ).toBe(false);
    });

    it('keeps the second outage held when a node sights the first recovery late', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 10_000, NOW);
      service.claimFailover('cluster-1', outageSignature(), NOW + 12_000, NOW + 10_000);
      service.claimFailover('cluster-1', recoverySightingSignature(), NOW + 12_500, NOW + 1_000);

      expect(
        service.claimFailover('cluster-1', outageSignature(), NOW + 17_500, NOW + 12_500),
      ).toBe(false);
    });

    it('is not held in the cluster for the outage a node shows after it left', () => {
      service.observe(SEED, view('a', 'b', 'c'));
      service.observe('member-1', view('a', 'b', 'c'));
      service.observe('member-1', view('c'));
      service.claimFailover(service.clusterKeyOf('member-1'), outageSignature(), NOW);

      expect(service.claimFailover(service.clusterKeyOf(SEED), outageSignature(), NOW)).toBe(true);
    });

    it('stays held in the cluster when a node comes back to it under a new node id', () => {
      service.observe(SEED, view('a', 'b'));
      service.claimFailover(service.clusterKeyOf(SEED), promotionSignature('a', 7), NOW);
      service.observe('member-1', view('z'));

      service.observe('member-1', view('z', 'a', 'b'));

      expect(
        service.claimFailover(service.clusterKeyOf('member-1'), followerSignature('a', 7), NOW),
      ).toBe(false);
    });

    it('keeps the outage of another cluster claimed when this one recovers', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);
      service.claimFailover('cluster-2', outageSignature(), NOW);

      service.claimFailover('cluster-1', clusterStateSignature('ok'), NOW + 10_000);

      expect(service.claimFailover('cluster-2', outageSignature(), NOW + 30_000)).toBe(false);
    });

    it('drops claims whose hold has passed', () => {
      service.claimFailover('cluster-1', outageSignature(), NOW);

      service.claimFailover('cluster-1', promotionSignature('node-b', 7), NOW + MINUTE_MS);

      expect(service['claims'].size).toBe(1);
    });
  });

  describe('cluster reader', () => {
    const readAll = (...ids: string[]): void => ids.forEach((id) => service.observe(id, view('a', 'b')));

    it('is the only connection that read the cluster', () => {
      readAll('member-1');

      expect(service.claimReader('member-1', NOW)).toBe(true);
      expect(service.isReader('member-1')).toBe(true);
    });

    it('is nobody before a connection claimed it', () => {
      readAll(SEED);

      expect(service.isReader(SEED)).toBe(false);
    });

    it('is the seed once it reads, also when a member read first', () => {
      readAll(SEED, 'member-1');
      service.claimReader('member-1', NOW);

      expect(service.claimReader(SEED, NOW)).toBe(true);
      expect(service.claimReader('member-1', NOW + 1000)).toBe(false);
      expect(service.isReader('member-1')).toBe(false);
    });

    it('is the lowest connection id when no user-added connection reads', () => {
      readAll('member-1', 'member-2');
      service.claimReader('member-2', NOW);

      expect(service.claimReader('member-1', NOW)).toBe(true);
      expect(service.claimReader('member-2', NOW + 1000)).toBe(false);
    });

    it('is the lowest connection id of two user-added connections', () => {
      configs['manual-2'] = {};
      readAll('manual', 'manual-2');
      service.claimReader('manual-2', NOW);

      expect(service.claimReader('manual', NOW)).toBe(true);
      expect(service.claimReader('manual-2', NOW + 1000)).toBe(false);
    });

    it('stays the seed for a minute after its last read', () => {
      readAll(SEED, 'member-1');
      service.claimReader(SEED, NOW);

      expect(service.claimReader('member-1', NOW + MINUTE_MS)).toBe(false);
      expect(service.isReader(SEED)).toBe(true);
    });

    it('moves to a member once the seed has not read for over a minute', () => {
      readAll(SEED, 'member-1');
      service.claimReader(SEED, NOW);

      expect(service.claimReader('member-1', NOW + MINUTE_MS + 1)).toBe(true);
      expect(service.isReader(SEED)).toBe(false);
    });

    it('counts the minute from the last read of the reader, not from its first', () => {
      readAll(SEED, 'member-1');
      service.claimReader(SEED, NOW);
      service.claimReader(SEED, NOW + MINUTE_MS);

      expect(service.claimReader('member-1', NOW + MINUTE_MS + 1)).toBe(false);
    });

    it('goes back to the seed when it reads again', () => {
      readAll(SEED, 'member-1');
      service.claimReader(SEED, NOW);
      service.claimReader('member-1', NOW + 2 * MINUTE_MS);

      expect(service.claimReader(SEED, NOW + 2 * MINUTE_MS + 1000)).toBe(true);
      expect(service.claimReader('member-1', NOW + 2 * MINUTE_MS + 2000)).toBe(false);
    });

    it('is separate for two clusters', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('manual', view('x', 'y'));

      expect(service.claimReader(SEED, NOW)).toBe(true);
      expect(service.claimReader('manual', NOW)).toBe(true);
    });

    it('moves at once when the reader is removed', () => {
      readAll(SEED, 'member-1');
      service.claimReader(SEED, NOW);
      delete configs[SEED];
      removalListeners.forEach((listener) => listener(SEED));

      expect(service.claimReader('member-1', NOW + 1000)).toBe(true);
    });

    it('moves at once when the reader now reads another cluster', () => {
      readAll('member-1', 'member-2');
      service.claimReader('member-1', NOW);
      service.observe('member-1', view('x', 'y'));

      expect(service.claimReader('member-2', NOW + 1000)).toBe(true);
      expect(service.claimReader('member-1', NOW + 1000)).toBe(true);
    });

    it('is one connection again after two clusters that were read apart are joined', () => {
      service.observe('member-1', view('a', 'b'));
      service.observe('member-2', view('c', 'd'));
      service.claimReader('member-1', NOW);
      service.claimReader('member-2', NOW);

      service.observe('member-2', view('a', 'b', 'c', 'd'));

      expect(service.isReader('member-1')).toBe(true);
      expect(service.isReader('member-2')).toBe(false);
      expect(service.claimReader('member-2', NOW + 1000)).toBe(false);
    });
  });

  describe('connections of the cluster', () => {
    it('lists the seed and its members, also one that has not read a view yet', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('a', 'b'));

      expect(service.clusterConnectionIds('member-1')).toEqual([SEED, 'member-1', 'member-2']);
    });

    it('lists the seed for a member while the seed has not read a view', () => {
      service.observe('member-1', view('a', 'b'));

      expect(service.clusterConnectionIds('member-1')).toEqual([SEED, 'member-1', 'member-2']);
    });

    it('leaves out the connections of another cluster', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('manual', view('x', 'y'));

      expect(service.clusterConnectionIds('manual')).toEqual(['manual']);
    });

    it('leaves out a member that reads another cluster than its seed', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('x', 'y'));

      expect(service.clusterConnectionIds(SEED)).toEqual([SEED, 'member-2']);
    });
  });

  describe('other connections of the cluster', () => {
    const others = (connectionId: string): string[] =>
      service.otherClusterConnections(connectionId).map((other) => other.connectionId);

    it('lists a second user-added connection whose view shares a node', () => {
      configs['manual-2'] = {};
      service.observe('manual', view('a', 'b'));
      service.observe('manual-2', view('b', 'c'));

      expect(others('manual')).toEqual(['manual-2']);
    });

    it('lists the members of the seed, also one that has not read a view yet', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('a', 'b'));

      expect(others(SEED)).toEqual(['member-1', 'member-2']);
    });

    it('lists the member that saw the change when the event is filed under a seed that is down', () => {
      connected.delete(SEED);
      service.observe('member-1', view('a', 'b'));

      expect(others('member-1')).toEqual(['member-1', 'member-2']);
    });

    it('lists a user-added connection next to the members of the seed', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('a', 'b'));
      service.observe('manual', view('b', 'c'));

      expect(others('member-1')).toEqual(['member-1', 'member-2', 'manual']);
    });

    it('lists the other members when the seed connection was removed', () => {
      delete configs[SEED];
      service.observe('member-1', view('a', 'b'));

      expect(others('member-1')).toEqual(['member-2']);
    });

    it('leaves out the connections of another cluster', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('manual', view('x', 'y'));

      expect(others(SEED)).toEqual(['member-1', 'member-2']);
      expect(others('manual')).toEqual([]);
    });

    it('leaves out a member that reads another cluster than its seed', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('x', 'y'));

      expect(others(SEED)).toEqual(['member-2']);
    });

    it('leaves out the seed and its members for a member that reads another cluster', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('x', 'y'));

      expect(others('member-1')).toEqual([]);
    });

    it('lists nothing for a node that lists only itself after it left the cluster', () => {
      service.observe(SEED, view('a', 'b', 'c'));
      service.observe('member-1', view('a', 'b', 'c'));
      service.observe('member-1', view('c'));

      expect(others('member-1')).toEqual([]);
      expect(service.eventConnectionOf('member-1')).toBe('member-1');
    });

    it('gives each connection its own host and port', () => {
      service.observe(SEED, view('a', 'b'));

      expect(service.otherClusterConnections(SEED)[0]).toEqual({
        connectionId: 'member-1',
        instance: { host: 'member-1.internal', port: 6379 },
      });
    });
  });

  describe('connection an event is filed under', () => {
    it('is the seed for an auto-registered member while the seed is connected', () => {
      expect(service.eventConnectionOf('member-1')).toBe(SEED);
    });

    it('is the seed also while the seed is not connected', () => {
      connected.delete(SEED);

      expect(service.eventConnectionOf('member-1')).toBe(SEED);
    });

    it('is the member itself when it reads another cluster than its seed', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('x', 'y'));

      expect(service.eventConnectionOf('member-1')).toBe('member-1');
    });

    it('is the seed for a member whose view was joined with the view of the seed', () => {
      service.observe(SEED, view('a', 'b'));
      service.observe('member-1', view('x', 'y'));
      service.observe('member-1', view('x', 'y', 'a'));

      expect(service.eventConnectionOf('member-1')).toBe(SEED);
    });

    it('is the member itself when the seed no longer exists', () => {
      delete configs[SEED];

      expect(service.eventConnectionOf('member-1')).toBe('member-1');
    });

    it('is the connection itself for one a user added and the seed adopted', () => {
      configs.adopted = memberOf(SEED, 'adopted');

      expect(service.eventConnectionOf('adopted')).toBe('adopted');
    });

    it('is the connection itself for one without a seed', () => {
      expect(service.eventConnectionOf('manual')).toBe('manual');
    });
  });
});
