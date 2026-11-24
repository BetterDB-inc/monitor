import type { DatabaseConnectionConfig, TopologyMembership } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  ClusterIdentityService,
  clusterStateSignature,
  followerSignature,
  outageSignature,
  promotionSignature,
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

    it('is the seed id for a member and its seed before either has read a view', () => {
      expect(service.clusterKeyOf('member-1')).toBe(SEED);
      expect(service.clusterKeyOf(SEED)).toBe(SEED);
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

  describe('connection an event is filed under', () => {
    it('is the seed for an auto-registered member while the seed is connected', () => {
      expect(service.eventConnectionOf('member-1')).toBe(SEED);
    });

    it('is the seed also while the seed is not connected', () => {
      connected.delete(SEED);

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
