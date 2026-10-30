import {
  ClientListEntry,
  ClientSnapshotEntry,
  contributorKey,
  describeRetryAmplificationContributors,
  rankRetryAmplificationContributors,
  readClientCommandCounts,
} from '../retry-amplification-attribution';

function client(overrides: Partial<ClientListEntry> & { id: string }): ClientListEntry {
  return { addr: '10.0.0.1:5000', name: '', user: 'default', age: 1000, ...overrides };
}

function snap(overrides: Partial<ClientSnapshotEntry> & { clientId: string }): ClientSnapshotEntry {
  return {
    addr: '10.0.0.1:5000',
    name: '',
    user: 'default',
    age: 1000,
    capturedAt: 0,
    ...overrides,
  };
}

describe('retry amplification attribution', () => {
  describe('contributorKey', () => {
    it('prefers name, then a non-default user, then the client IP', () => {
      expect(contributorKey({ name: 'api', user: 'svc', addr: '1.2.3.4:9' })).toEqual({
        key: 'api',
        keyKind: 'name',
      });
      expect(contributorKey({ name: '', user: 'svc', addr: '1.2.3.4:9' })).toEqual({
        key: 'svc',
        keyKind: 'user',
      });
      expect(contributorKey({ name: '', user: 'default', addr: '1.2.3.4:9' })).toEqual({
        key: '1.2.3.4',
        keyKind: 'ip',
      });
      expect(contributorKey({ name: '', user: '', addr: '[::1]:6379' })).toEqual({
        key: '[::1]',
        keyKind: 'ip',
      });
    });
  });

  describe('readClientCommandCounts', () => {
    it('returns null when no client carries tot-cmds (Redis, Valkey < 8)', () => {
      expect(readClientCommandCounts([client({ id: '1' })], 0)).toBeNull();
    });

    it('reads tot-cmds per client id', () => {
      const snapshot = readClientCommandCounts(
        [client({ id: '1', name: 'api', 'tot-cmds': '500' }), client({ id: '2' })],
        1_000,
      );
      expect(snapshot?.clients.size).toBe(1);
      expect(snapshot?.clients.get('1')).toEqual(
        expect.objectContaining({ key: 'api', keyKind: 'name', totalCommands: 500 }),
      );
    });
  });

  describe('rankRetryAmplificationContributors', () => {
    it('ranks by command-rate growth against each client lifetime rate', () => {
      const first = readClientCommandCounts(
        [
          client({ id: '1', name: 'checkout', age: 100, 'tot-cmds': '1000' }),
          client({ id: '2', name: 'search', age: 100, 'tot-cmds': '1000' }),
          client({ id: '3', name: 'idle', age: 100, 'tot-cmds': '1000' }),
        ],
        0,
      );
      const latest = readClientCommandCounts(
        [
          client({ id: '1', name: 'checkout', age: 160, 'tot-cmds': '4000' }),
          client({ id: '2', name: 'search', age: 160, 'tot-cmds': '2200' }),
          client({ id: '3', name: 'idle', age: 160, 'tot-cmds': '1300' }),
        ],
        60_000,
      );

      const ranked = rankRetryAmplificationContributors({
        first,
        latest,
        snapshots: [],
        snapshotIntervalMs: 60_000,
      });

      expect(ranked.map((c) => c.key)).toEqual(['checkout', 'search']);
      expect(ranked[0].commandRateGrowth).toBeCloseTo(5, 5);
      expect(ranked[1].commandRateGrowth).toBeCloseTo(2, 5);
    });

    it('falls back to reconnect counts when tot-cmds is missing', () => {
      const snapshots = [
        snap({ clientId: 'a', name: 'worker', age: 3, capturedAt: 60_000 }),
        snap({ clientId: 'b', name: 'worker', age: 10, capturedAt: 120_000 }),
        snap({ clientId: 'c', name: 'worker', age: 2, capturedAt: 120_000 }),
        snap({ clientId: 'd', name: 'cron', age: 5000, capturedAt: 120_000 }),
        snap({ clientId: 'e', addr: '10.9.9.9:1', age: 1, capturedAt: 120_000 }),
      ];

      const ranked = rankRetryAmplificationContributors({
        first: readClientCommandCounts([client({ id: '1' })], 0),
        latest: null,
        snapshots,
        snapshotIntervalMs: 60_000,
      });

      expect(ranked).toEqual([
        {
          key: 'worker',
          keyKind: 'name',
          commandRateGrowth: null,
          newConnections: 3,
          connections: 2,
        },
        {
          key: '10.9.9.9',
          keyKind: 'ip',
          commandRateGrowth: null,
          newConnections: 1,
          connections: 1,
        },
      ]);
    });

    it('combines command growth and reconnects for the same key', () => {
      const first = readClientCommandCounts(
        [client({ id: '1', name: 'api', age: 100, 'tot-cmds': '100' })],
        0,
      );
      const latest = readClientCommandCounts(
        [client({ id: '1', name: 'api', age: 110, 'tot-cmds': '400' })],
        10_000,
      );
      const ranked = rankRetryAmplificationContributors({
        first,
        latest,
        snapshots: [snap({ clientId: '9', name: 'api', age: 4, capturedAt: 10_000 })],
        snapshotIntervalMs: 60_000,
      });

      expect(ranked).toEqual([
        { key: 'api', keyKind: 'name', commandRateGrowth: 30, newConnections: 1, connections: 1 },
      ]);
    });

    it('ignores clients that reset or vanished between snapshots and caps the list', () => {
      const ids = Array.from({ length: 8 }, (_, i) => String(i));
      const first = readClientCommandCounts(
        ids.map((id) => client({ id, name: `c${id}`, age: 10, 'tot-cmds': '10' })),
        0,
      );
      const latest = readClientCommandCounts(
        [
          ...ids
            .slice(0, 7)
            .map((id) =>
              client({ id, name: `c${id}`, age: 20, 'tot-cmds': String(100 + Number(id)) }),
            ),
          client({ id: '7', name: 'c7', age: 1, 'tot-cmds': '1' }),
        ],
        10_000,
      );

      const ranked = rankRetryAmplificationContributors({
        first,
        latest,
        snapshots: [],
        snapshotIntervalMs: 60_000,
      });

      expect(ranked).toHaveLength(5);
      expect(ranked[0].key).toBe('c6');
      expect(ranked.map((c) => c.key)).not.toContain('c7');
    });

    it('keeps reconnecting clients in the top list next to pooled groups', () => {
      const ids = Array.from({ length: 6 }, (_, i) => String(i));
      const first = readClientCommandCounts(
        ids.map((id) => client({ id, name: `pool${id}`, age: 100, 'tot-cmds': '1000' })),
        0,
      );
      const latest = readClientCommandCounts(
        ids.map((id) =>
          client({
            id,
            name: `pool${id}`,
            age: 160,
            'tot-cmds': String(1000 + 600 * (2 + Number(id))),
          }),
        ),
        60_000,
      );
      const snapshots = [
        snap({ clientId: 'r1', name: 'retrier', age: 2, capturedAt: 60_000 }),
        snap({ clientId: 'r2', name: 'retrier', age: 5, capturedAt: 60_000 }),
      ];

      const ranked = rankRetryAmplificationContributors({
        first,
        latest,
        snapshots,
        snapshotIntervalMs: 60_000,
      });

      expect(ranked).toHaveLength(5);
      expect(ranked[1]).toEqual(
        expect.objectContaining({ key: 'retrier', commandRateGrowth: null, newConnections: 2 }),
      );
    });

    it('drops clients whose command rate barely moved', () => {
      const first = readClientCommandCounts(
        [client({ id: '1', name: 'steady', age: 100, 'tot-cmds': '1000' })],
        0,
      );
      const latest = readClientCommandCounts(
        [client({ id: '1', name: 'steady', age: 160, 'tot-cmds': '1630' })],
        60_000,
      );
      expect(
        rankRetryAmplificationContributors({
          first,
          latest,
          snapshots: [],
          snapshotIntervalMs: 60_000,
        }),
      ).toEqual([]);
    });

    it('returns nothing when neither source has data', () => {
      expect(
        rankRetryAmplificationContributors({
          first: null,
          latest: null,
          snapshots: [],
          snapshotIntervalMs: 60_000,
        }),
      ).toEqual([]);
    });
  });

  describe('describeRetryAmplificationContributors', () => {
    it('formats contributors, an empty list and an unavailable source', () => {
      expect(
        describeRetryAmplificationContributors([
          {
            key: 'api',
            keyKind: 'name',
            commandRateGrowth: 3.04,
            newConnections: 12,
            connections: 4,
          },
          {
            key: '10.0.0.5',
            keyKind: 'ip',
            commandRateGrowth: null,
            newConnections: 7,
            connections: 1,
          },
        ]),
      ).toBe('Top clients: name api (cmds 3.0×, 12 reconnects); ip 10.0.0.5 (7 reconnects).');
      expect(describeRetryAmplificationContributors([])).toBe('No client stood out.');
      expect(describeRetryAmplificationContributors(null)).toBe('Client attribution unavailable.');
    });
  });
});
