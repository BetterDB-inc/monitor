import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  AnomalyQueryOptions,
  StoragePort,
  StoredAnomalyEvent,
} from '../../../common/interfaces/storage-port.interface';

const CONN = 'conn-a';

const event = (
  id: string,
  timestamp: number,
  overrides: Partial<StoredAnomalyEvent> = {},
): StoredAnomalyEvent => ({
  id,
  timestamp,
  metricType: 'connections',
  anomalyType: 'spike',
  severity: 'warning',
  value: 1,
  baseline: 1,
  stdDev: 1,
  zScore: 1,
  threshold: 1,
  message: 'm',
  resolved: false,
  ...overrides,
});

describe.each<[string, AdapterFactory]>(adapters)(
  'getAnomalyEvents signal filters (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;

    const seed = async (events: StoredAnomalyEvent[]) => {
      for (const e of events) await storage.saveAnomalyEvent(e, CONN);
    };

    const ids = async (options: AnomalyQueryOptions) =>
      (await storage.getAnomalyEvents({ connectionId: CONN, order: 'asc', ...options })).map(
        (e) => e.id,
      );

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    describe('node address', () => {
      beforeEach(() =>
        seed([
          event('a', 1000, { nodeAddr: '10.0.0.1:6379' }),
          event('b', 2000, { nodeAddr: '10.0.0.2:6379' }),
          event('c', 3000),
          event('d', 4000, { nodeAddr: '' }),
          event('e', 5000, { nodeAddr: '10.0.0.1:6379' }),
        ]),
      );

      it('returns every event when no node filter is given', async () => {
        expect(await ids({})).toEqual(['a', 'b', 'c', 'd', 'e']);
      });

      it('returns only the events of the given node', async () => {
        expect(await ids({ nodeAddr: '10.0.0.1:6379' })).toEqual(['a', 'e']);
      });

      it('returns events with a missing or empty node address for a null filter', async () => {
        expect(await ids({ nodeAddr: null })).toEqual(['c', 'd']);
      });

      it('treats an empty node filter like null', async () => {
        expect(await ids({ nodeAddr: '' })).toEqual(['c', 'd']);
      });

      it('returns the earliest matching event after a time, not the earliest event', async () => {
        expect(await ids({ nodeAddr: '10.0.0.1:6379', startTime: 1001, limit: 1 })).toEqual(['e']);
      });
    });

    describe('commands', () => {
      const withCommands = (id: string, timestamp: number, commands?: string[]) =>
        event(id, timestamp, { metricType: 'command_p99', ...(commands ? { commands } : {}) });

      beforeEach(() =>
        seed([
          withCommands('p', 1000, ['GET', 'SET']),
          withCommands('q', 2000, ['SET', 'GET']),
          withCommands('r', 3000, ['GET']),
          withCommands('s', 4000),
          withCommands('t', 5000, []),
          withCommands('u', 6000, ['a,b']),
          withCommands('v', 7000, ['a', 'b']),
          withCommands('w', 8000, ['say "hi"']),
          withCommands('x', 9000, ['GET', 'SET']),
        ]),
      );

      it('returns every event when no commands filter is given', async () => {
        expect(await ids({})).toEqual(['p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x']);
      });

      it('matches the command list exactly, in order', async () => {
        expect(await ids({ commands: ['GET', 'SET'] })).toEqual(['p', 'x']);
        expect(await ids({ commands: ['GET'] })).toEqual(['r']);
      });

      it('returns events with a missing or empty command list for an empty filter', async () => {
        expect(await ids({ commands: [] })).toEqual(['s', 't']);
      });

      it('does not confuse a comma inside a command with two commands', async () => {
        expect(await ids({ commands: ['a,b'] })).toEqual(['u']);
        expect(await ids({ commands: ['a', 'b'] })).toEqual(['v']);
      });

      it('matches a command containing a quote', async () => {
        expect(await ids({ commands: ['say "hi"'] })).toEqual(['w']);
      });

      it('combines with the node filter and a one-row limit', async () => {
        expect(
          await ids({ commands: ['GET', 'SET'], nodeAddr: null, startTime: 1001, limit: 1 }),
        ).toEqual(['x']);
      });
    });
  },
);
