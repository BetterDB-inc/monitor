import type { ClientSnapshotGroupRow } from '@betterdb/shared';
import { clientAddrIp } from '@app/storage/adapters/client-analytics-stats';
import { RETRY_AMP_EVENT_GRACE_MS, RETRY_AMP_WINDOW_MS } from '../retry-amplification-detector';
import {
  ClientCommandSnapshot,
  ClientListEntry,
  contributorKey,
  describeRetryAmplificationContributors,
  estimateNewConnections,
  pushClientSnapshot,
  rankRetryAmplificationContributors,
  RETRY_AMP_CLIENT_SNAPSHOTS,
  RETRY_AMP_MIN_NEW_CONNECTIONS,
  readClientCommandCounts,
  selectClientSnapshots,
} from '../retry-amplification-attribution';

function client(overrides: Partial<ClientListEntry> & { id: string }): ClientListEntry {
  return { addr: '10.0.0.1:5000', name: '', user: 'default', ...overrides };
}

function snapshot(takenAt: number, clients: ClientListEntry[]) {
  return readClientCommandCounts(clients, takenAt);
}

function group(overrides: Partial<ClientSnapshotGroupRow>): ClientSnapshotGroupRow {
  return {
    capturedAt: 0,
    name: '',
    user: 'default',
    ip: '10.0.0.1',
    count: 1,
    ageSum: 1000,
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

  describe('contributorKey address parsing', () => {
    it('groups an address the same way as the client analytics IP rule', () => {
      const addr = 'worker-node:notaport';
      expect(contributorKey({ name: '', user: '', addr })).toEqual({
        key: clientAddrIp(addr),
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
    it('keeps a client that always connects per request out of the reconnect slots', () => {
      const group = (name: string, count: number) => ({ name, user: 'default', ip: '10.0.0.1', count });

      const ranked = rankRetryAmplificationContributors({
        before: null,
        first: null,
        latest: null,
        capture: [],
        newConnections: [group('php-fpm', 900), group('storm', 40)],
        baselineConnections: [group('php-fpm', 880)],
      });

      expect(ranked.map((c) => c.key)).toEqual(['storm']);
    });

    it('ranks by command-rate growth against the pre-episode rate', () => {
      const before = snapshot(0, [
        client({ id: '1', name: 'checkout', 'tot-cmds': '1000' }),
        client({ id: '2', name: 'search', 'tot-cmds': '1000' }),
        client({ id: '3', name: 'idle', 'tot-cmds': '1000' }),
      ]);
      const first = snapshot(60_000, [
        client({ id: '1', name: 'checkout', 'tot-cmds': '1600' }),
        client({ id: '2', name: 'search', 'tot-cmds': '1600' }),
        client({ id: '3', name: 'idle', 'tot-cmds': '1600' }),
      ]);
      const latest = snapshot(120_000, [
        client({ id: '1', name: 'checkout', 'tot-cmds': '4600' }),
        client({ id: '2', name: 'search', 'tot-cmds': '2800' }),
        client({ id: '3', name: 'idle', 'tot-cmds': '2200' }),
      ]);

      const ranked = rankRetryAmplificationContributors({
        before,
        first,
        latest,
        capture: [],
        newConnections: [],
      });

      expect(ranked.map((c) => c.key)).toEqual(['checkout', 'search']);
      expect(ranked[0].commandRateGrowth).toBeCloseTo(5, 5);
      expect(ranked[1].commandRateGrowth).toBeCloseTo(2, 5);
    });

    it('ranks a large absolute increase over a small client with a higher ratio', () => {
      const before = snapshot(0, [
        client({ id: '1', name: 'api', 'tot-cmds': '1000' }),
        client({ id: '2', name: 'health', 'tot-cmds': '1000' }),
      ]);
      const first = snapshot(60_000, [
        client({ id: '1', name: 'api', 'tot-cmds': '61000' }),
        client({ id: '2', name: 'health', 'tot-cmds': '1036' }),
      ]);
      const latest = snapshot(120_000, [
        client({ id: '1', name: 'api', 'tot-cmds': '175000' }),
        client({ id: '2', name: 'health', 'tot-cmds': '1126' }),
      ]);

      const ranked = rankRetryAmplificationContributors({
        before,
        first,
        latest,
        capture: [],
        newConnections: [],
      });

      expect(ranked.map((c) => c.key)).toEqual(['api', 'health']);
    });

    it('ignores a long lifetime average when the client was already busy', () => {
      const before = snapshot(0, [
        client({ id: '1', name: 'nightly', 'tot-cmds': '1000' }),
      ]);
      const first = snapshot(60_000, [
        client({ id: '1', name: 'nightly', 'tot-cmds': '7000' }),
      ]);
      const latest = snapshot(120_000, [
        client({ id: '1', name: 'nightly', 'tot-cmds': '13000' }),
      ]);

      expect(
        rankRetryAmplificationContributors({
          before,
          first,
          latest,
          capture: [],
          newConnections: [],
        }),
      ).toEqual([]);
    });

    it('counts commands of clients that reconnected during the episode', () => {
      const before = snapshot(0, [client({ id: '1', name: 'storm', 'tot-cmds': '1000' })]);
      const first = snapshot(60_000, [client({ id: '1', name: 'storm', 'tot-cmds': '1600' })]);
      const latest = snapshot(120_000, [
        client({ id: '41', name: 'storm', 'tot-cmds': '1500' }),
        client({ id: '42', name: 'storm', 'tot-cmds': '1500' }),
      ]);

      const [storm] = rankRetryAmplificationContributors({
        before,
        first,
        latest,
        capture: [],
        newConnections: [{ name: 'storm', user: 'default', ip: '10.0.0.1', count: 2 }],
      });

      expect(storm.key).toBe('storm');
      expect(storm.commandRateGrowth).toBeCloseTo(5, 5);
    });

    it('leaves growth unknown without a pre-episode rate', () => {
      const first = snapshot(60_000, [client({ id: '1', name: 'api', 'tot-cmds': '1600' })]);
      const latest = snapshot(120_000, [client({ id: '1', name: 'api', 'tot-cmds': '9000' })]);

      const ranked = rankRetryAmplificationContributors({
        before: null,
        first,
        latest,
        capture: [],
        newConnections: [{ name: 'api', user: 'default', ip: '10.0.0.1', count: 3 }],
      });

      expect(ranked[0].commandRateGrowth).toBeNull();
    });

    it('falls back to reconnect counts when tot-cmds is missing', () => {
      const capture = [
        group({ name: 'worker', count: 2 }),
        group({ name: 'cron' }),
        group({ ip: '10.9.9.9' }),
      ];
      const newConnections = [
        { name: 'worker', user: 'default', ip: '10.0.0.1', count: 4 },
        { name: '', user: 'default', ip: '10.9.9.9', count: 3 },
      ];

      const ranked = rankRetryAmplificationContributors({
        before: null,
        first: readClientCommandCounts([client({ id: '1' })], 0),
        latest: null,
        capture,
        newConnections,
      });

      expect(ranked).toEqual([
        {
          key: 'worker',
          keyKind: 'name',
          commandRateGrowth: null,
          newConnections: 4,
          connections: 2,
        },
        {
          key: '10.9.9.9',
          keyKind: 'ip',
          commandRateGrowth: null,
          newConnections: 3,
          connections: 1,
        },
      ]);
    });

    it('combines command growth and reconnects for the same key', () => {
      const before = snapshot(0, [client({ id: '1', name: 'api', 'tot-cmds': '100' })]);
      const first = snapshot(10_000, [client({ id: '1', name: 'api', 'tot-cmds': '200' })]);
      const latest = snapshot(20_000, [client({ id: '1', name: 'api', 'tot-cmds': '500' })]);
      const ranked = rankRetryAmplificationContributors({
        before,
        first,
        latest,
        capture: [group({ name: 'api' })],
        newConnections: [{ name: 'api', user: 'default', ip: '10.0.0.1', count: 1 }],
      });

      expect(ranked).toEqual([
        { key: 'api', keyKind: 'name', commandRateGrowth: 3, newConnections: 1, connections: 1 },
      ]);
    });

    it('groups new connections by contributor key and adds across addresses', () => {
      const ranked = rankRetryAmplificationContributors({
        before: null,
        first: null,
        latest: null,
        capture: [],
        newConnections: [
          { name: 'api', user: 'default', ip: '10.0.0.1', count: 2 },
          { name: 'api', user: 'default', ip: '10.0.0.2', count: 3 },
          { name: '', user: 'svc', ip: '10.0.0.3', count: 3 },
          { name: '', user: 'default', ip: '[::1]', count: 3 },
        ],
      });

      expect(ranked.map((c) => [c.key, c.keyKind, c.newConnections])).toEqual([
        ['api', 'name', 5],
        ['[::1]', 'ip', 3],
        ['svc', 'user', 3],
      ]);
    });

    it('adds the live connections of a contributor across addresses', () => {
      const ranked = rankRetryAmplificationContributors({
        before: null,
        first: null,
        latest: null,
        capture: [group({ name: 'api', count: 2 }), group({ name: 'api', ip: '10.0.0.2' })],
        newConnections: [{ name: 'api', user: 'default', ip: '10.0.0.1', count: 3 }],
      });

      expect(ranked[0].connections).toBe(3);
    });

    it('ignores clients whose counter reset between snapshots and caps the list', () => {
      const ids = Array.from({ length: 8 }, (_, i) => String(i));
      const idle = (takenAt: number, total: string) =>
        snapshot(
          takenAt,
          ids.map((id) => client({ id, name: `c${id}`, 'tot-cmds': total })),
        );
      const latest = snapshot(20_000, [
        ...ids
          .slice(0, 7)
          .map((id) => client({ id, name: `c${id}`, 'tot-cmds': String(100 + Number(id)) })),
        client({ id: '7', name: 'c7', 'tot-cmds': '1' }),
      ]);

      const ranked = rankRetryAmplificationContributors({
        before: idle(0, '10'),
        first: idle(10_000, '20'),
        latest,
        capture: [],
        newConnections: [],
      });

      expect(ranked).toHaveLength(5);
      expect(ranked[0].key).toBe('c6');
      expect(ranked.map((c) => c.key)).not.toContain('c7');
    });

    it('keeps reconnecting clients in the top list next to pooled groups', () => {
      const ids = Array.from({ length: 6 }, (_, i) => String(i));
      const pool = (takenAt: number, total: (id: string) => number) =>
        snapshot(
          takenAt,
          ids.map((id) => client({ id, name: `pool${id}`, 'tot-cmds': String(total(id)) })),
        );
      const capture = [group({ name: 'retrier', count: 2 })];

      const ranked = rankRetryAmplificationContributors({
        before: pool(0, () => 400),
        first: pool(60_000, () => 1000),
        latest: pool(120_000, (id) => 1000 + 600 * (2 + Number(id))),
        capture,
        newConnections: [{ name: 'retrier', user: 'default', ip: '10.0.0.1', count: 3 }],
      });

      expect(ranked).toHaveLength(5);
      expect(ranked[1]).toEqual(
        expect.objectContaining({ key: 'retrier', commandRateGrowth: null, newConnections: 3 }),
      );
    });

    it("leaves BetterDB's own connections out of the ranking", () => {
      const at = (takenAt: number, monitor: number, api: number) =>
        snapshot(takenAt, [
          client({ id: '1', name: 'BetterDB-Monitor', 'tot-cmds': String(monitor) }),
          client({ id: '2', name: 'BetterDB-Monitor-keyscan', 'tot-cmds': String(monitor) }),
          client({ id: '3', name: 'api', 'tot-cmds': String(api) }),
        ]);

      const ranked = rankRetryAmplificationContributors({
        before: at(0, 100, 1000),
        first: at(60_000, 200, 1600),
        latest: at(120_000, 20_000, 4600),
        capture: [group({ name: 'BetterDB-Monitor', count: 2 })],
        newConnections: [{ name: 'BetterDB-Monitor-Node-1', user: 'default', ip: '10.0.0.9', count: 9 }],
      });

      expect(ranked.map((c) => c.key)).toEqual(['api']);
    });

    it('keeps an application whose name only starts with the monitor name', () => {
      const ranked = rankRetryAmplificationContributors({
        before: null,
        first: null,
        latest: null,
        capture: [],
        newConnections: [{ name: 'BetterDB-Monitoring', user: 'default', ip: '10.0.0.1', count: 9 }],
      });

      expect(ranked.map((c) => c.key)).toEqual(['BetterDB-Monitoring']);
    });

    it('drops clients whose command rate barely moved', () => {
      const steady = (takenAt: number, total: string) =>
        snapshot(takenAt, [client({ id: '1', name: 'steady', 'tot-cmds': total })]);

      expect(
        rankRetryAmplificationContributors({
          before: steady(0, '1000'),
          first: steady(60_000, '1600'),
          latest: steady(120_000, '2230'),
          capture: [],
          newConnections: [],
        }),
      ).toEqual([]);
    });

    it('leaves a near-idle client out of the growth ranking', () => {
      const reading = (takenAt: number, idle: number, api: number) =>
        snapshot(takenAt, [
          client({ id: '1', name: 'idle', 'tot-cmds': String(idle) }),
          client({ id: '2', name: 'api', 'tot-cmds': String(api) }),
        ]);
      const before = reading(0, 0, 0);
      const first = reading(100_000, 2, 10_000);
      const latest = reading(200_000, 52, 30_000);

      const ranked = rankRetryAmplificationContributors({
        before,
        first,
        latest,
        capture: [],
        newConnections: [],
      });

      expect(ranked.map((c) => c.key)).toEqual(['api']);
    });

    it('needs a few new connections before a client with no baseline counts', () => {
      const reconnects = (count: number) =>
        rankRetryAmplificationContributors({
          before: null,
          first: null,
          latest: null,
          capture: [],
          newConnections: [{ name: 'worker', user: 'default', ip: '10.0.0.1', count }],
        });

      expect(reconnects(RETRY_AMP_MIN_NEW_CONNECTIONS - 1)).toEqual([]);
      expect(reconnects(RETRY_AMP_MIN_NEW_CONNECTIONS).map((c) => c.key)).toEqual(['worker']);
    });

    it('returns nothing when neither source has data', () => {
      expect(
        rankRetryAmplificationContributors({
          before: null,
          first: null,
          latest: null,
          capture: [],
          newConnections: [],
        }),
      ).toEqual([]);
    });
  });

  describe('client snapshot history', () => {
    const at = (takenAt: number) => ({ takenAt, clients: new Map() });

    it('keeps a rolling set between episodes', () => {
      let history = [at(0)];
      for (let i = 1; i < 10; i++) history = pushClientSnapshot(history, at(i * 60_000), null);

      expect(history).toHaveLength(RETRY_AMP_CLIENT_SNAPSHOTS);
      expect(history[history.length - 1].takenAt).toBe(540_000);
    });

    it('keeps the rate pair when a run opens a window and its grace after it started', () => {
      const cadence = 30_000;
      const openDelay = RETRY_AMP_WINDOW_MS + RETRY_AMP_EVENT_GRACE_MS;
      for (let offset = 1_000; offset < cadence; offset += 1_000) {
        const episodeStart = 600_000 + offset;
        let history: ClientCommandSnapshot[] = [];
        for (let t = 0; t <= episodeStart + openDelay + 3 * cadence; t += cadence) {
          const open = t >= episodeStart + openDelay ? episodeStart : null;
          history = pushClientSnapshot(history, at(t), open);
        }

        const { before, first, latest } = selectClientSnapshots(
          history,
          episodeStart,
          episodeStart + openDelay + 3 * cadence,
        );

        expect(before).not.toBeNull();
        expect(first).not.toBeNull();
        expect(latest).not.toBeNull();
      }
    });

    it('keeps the two snapshots before the episode however long it runs', () => {
      let history = [at(0), at(60_000), at(120_000), at(180_000)];
      for (let i = 4; i < 200; i++) {
        history = pushClientSnapshot(history, at(i * 60_000), 150_000);
      }

      expect(history.map((s) => s.takenAt)).toEqual([60_000, 120_000, 199 * 60_000]);
    });

    it('selects the rate pair before the episode and the newest reading inside it', () => {
      const history = [at(60_000), at(120_000), at(180_000), at(240_000), at(300_000)];

      const { before, first, latest } = selectClientSnapshots(history, 130_000, 260_000);

      expect(before?.takenAt).toBe(60_000);
      expect(first?.takenAt).toBe(120_000);
      expect(latest?.takenAt).toBe(240_000);
    });

    it('never pairs a snapshot with itself when the run outpaces the reads', () => {
      const { first, latest } = selectClientSnapshots([at(60_000)], 60_000, 120_000);

      expect(first?.takenAt).toBe(60_000);
      expect(latest).toBeNull();
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

describe('estimateNewConnections', () => {
  const identity = { name: 'worker', user: 'default', ip: '10.0.0.1' };
  const capture = (capturedAt: number, maxClientId: number, oldestAge: number, name = 'worker') => ({
    ...identity,
    name,
    capturedAt,
    maxClientId,
    oldestAge,
  });

  it('credits the id growth between captures to the only fresh client', () => {
    const groups = [{ ...identity, count: 2 }];
    const captures = [capture(0, 100, 5), capture(60_000, 130, 1), capture(120_000, 160, 1)];

    expect(estimateNewConnections(groups, captures, 60_000, 120_000)).toEqual([
      { ...identity, count: 60 },
    ]);
  });

  it('shares the growth between clients that are fresh in the same capture', () => {
    const captures = [
      capture(0, 100, 5),
      capture(60_000, 130, 1),
      capture(60_000, 120, 2, 'other'),
    ];

    expect(estimateNewConnections([], captures, 60_000, 60_000)).toEqual([
      { ...identity, count: 15 },
      { ...identity, name: 'other', count: 15 },
    ]);
  });

  it('gives no growth to clients older than the previous capture', () => {
    const captures = [capture(0, 100, 5), capture(60_000, 130, 61)];

    expect(estimateNewConnections([], captures, 60_000, 60_000)).toEqual([]);
  });

  it('credits the growth to a retrier and not a pool with older connections', () => {
    const captures = [
      capture(0, 100, 5),
      capture(0, 90, 500, 'pool'),
      capture(60_000, 130, 1),
      capture(60_000, 129, 560, 'pool'),
    ];

    expect(estimateNewConnections([], captures, 60_000, 60_000)).toEqual([
      { ...identity, count: 30 },
    ]);
  });

  it('ignores the drop in ids after a server restart', () => {
    const captures = [capture(0, 5_000, 5), capture(60_000, 12, 1)];

    expect(estimateNewConnections([], captures, 60_000, 60_000)).toEqual([]);
  });

  it('keeps the observed count when ids grew less than it', () => {
    const groups = [{ ...identity, count: 4 }];
    const captures = [capture(0, 100, 5), capture(60_000, 101, 1)];

    expect(estimateNewConnections(groups, captures, 60_000, 60_000)).toEqual(groups);
  });

  it('handles a capture with more identities than a spread call can take', () => {
    const fresh = Array.from({ length: 200_000 }, (_, i) =>
      capture(60_000, 130 + i, 1, `client-${i}`),
    );

    expect(() =>
      estimateNewConnections([], [capture(0, 100, 5), ...fresh], 60_000, 60_000),
    ).not.toThrow();
  });

  it('counts only captures inside the range', () => {
    const captures = [capture(0, 100, 5), capture(60_000, 900, 1), capture(120_000, 910, 1)];

    expect(estimateNewConnections([], captures, 120_000, 120_000)).toEqual([
      { ...identity, count: 10 },
    ]);
  });
});
