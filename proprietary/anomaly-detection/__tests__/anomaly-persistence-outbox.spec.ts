import { AnomalyEvent } from '../types';
import {
  OUTBOX_CLOSE_MAX_AGE_MS,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ENTRIES,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
  OutboxEntry,
  PersistenceOutbox,
} from '../anomaly-persistence-outbox';

const event = (id: string) => ({ id }) as AnomalyEvent;

describe('PersistenceOutbox', () => {
  let dropped: Array<[string, string]>;
  let outbox: PersistenceOutbox;

  beforeEach(() => {
    dropped = [];
    outbox = new PersistenceOutbox((entry: OutboxEntry, reason) => dropped.push([entry.id, reason]));
  });

  it('keeps the first entry for an id', () => {
    outbox.enqueueResolve('a', 100, 0);
    outbox.enqueueResolve('a', 200, 0);

    expect(outbox.resolvedAt('a')).toBe(100);
    expect(outbox.size).toBe(1);
  });

  it('lets a pending save carry a later resolve', () => {
    const anomaly = event('a');
    outbox.enqueueSave(anomaly, undefined, 0);
    outbox.enqueueResolve('a', 100, 0);

    expect(outbox.unsavedAnomaly('a')).toBe(anomaly);
    expect(outbox.resolvedAt('a')).toBeUndefined();
  });

  it('settles an id', () => {
    outbox.enqueueSave(event('a'), undefined, 0);

    outbox.settle('a');

    expect(outbox.has('a')).toBe(false);
  });

  it('settles a save but leaves a pending resolve', () => {
    outbox.enqueueSave(event('a'), undefined, 0);
    outbox.enqueueResolve('b', 100, 0);

    outbox.settleSave('a');
    outbox.settleSave('b');

    expect(outbox.has('a')).toBe(false);
    expect(outbox.resolvedAt('b')).toBe(100);
  });

  it('marks a rewrite of a stored event', () => {
    outbox.enqueueRewrite(event('a'), 0);
    outbox.enqueueSave(event('b'), undefined, 0);

    expect(outbox.due(0).map((entry) => entry.kind === 'save' && entry.rewrite)).toEqual([true, undefined]);
  });

  it('lets a rewrite carry a pending resolve', () => {
    const anomaly = event('a');
    outbox.enqueueResolve('a', 100, 0);

    outbox.enqueueRewrite(anomaly, 0);

    expect(outbox.unsavedAnomaly('a')).toBe(anomaly);
    expect(anomaly).toMatchObject({ resolved: true, resolvedAt: 100 });
  });

  it('settles a resolve but leaves a pending save', () => {
    outbox.enqueueSave(event('a'), undefined, 0);
    outbox.enqueueResolve('b', 100, 0);

    outbox.settleResolve('a');
    outbox.settleResolve('b');

    expect(outbox.has('a')).toBe(true);
    expect(outbox.has('b')).toBe(false);
  });

  it('waits longer after each failed retry, up to the limit', () => {
    outbox.enqueueSave(event('a'), undefined, 0);
    expect(outbox.due(0)).toHaveLength(1);

    outbox.defer('a', 0);
    expect(outbox.due(OUTBOX_RETRY_BASE_MS - 1)).toEqual([]);
    expect(outbox.due(OUTBOX_RETRY_BASE_MS)).toHaveLength(1);

    outbox.defer('a', 0);
    expect(outbox.due(2 * OUTBOX_RETRY_BASE_MS - 1)).toEqual([]);
    expect(outbox.due(2 * OUTBOX_RETRY_BASE_MS)).toHaveLength(1);

    for (let i = 0; i < 20; i++) outbox.defer('a', 0);
    expect(outbox.due(OUTBOX_RETRY_MAX_MS - 1)).toEqual([]);
    expect(outbox.due(OUTBOX_RETRY_MAX_MS)).toHaveLength(1);
  });

  it('expires a deferred entry on schedule', () => {
    outbox.enqueueSave(event('a'), undefined, 0);
    outbox.defer('a', OUTBOX_MAX_AGE_MS);

    expect(outbox.due(OUTBOX_MAX_AGE_MS + 1)).toEqual([]);
    expect(dropped).toEqual([['a', 'expired']]);
  });

  it('drops the oldest entry when full', () => {
    for (let i = 0; i <= OUTBOX_MAX_ENTRIES; i++) outbox.enqueueSave(event(`id-${i}`), undefined, 0);

    expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
    expect(outbox.has('id-0')).toBe(false);
    expect(dropped).toEqual([['id-0', 'full']]);
  });

  describe('a resolve whose row is missing', () => {
    it('expires once the row has been missing past the age limit', () => {
      const onDrop = jest.fn();
      const entryDrop = jest.fn();
      const outbox = new PersistenceOutbox(onDrop);
      outbox.enqueueResolve('a', 100, 0, entryDrop);

      outbox.markRowMissing('a', 5);
      expect(outbox.due(5 + OUTBOX_MAX_AGE_MS).map((entry) => entry.id)).toEqual(['a']);

      outbox.due(5 + OUTBOX_MAX_AGE_MS + 1);
      expect(outbox.size).toBe(0);
      expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'expired');
      expect(entryDrop).toHaveBeenCalledTimes(1);
    });

    it('counts the age from the first missing read', () => {
      const outbox = new PersistenceOutbox(jest.fn());
      outbox.enqueueResolve('a', 100, 0);

      outbox.markRowMissing('a', OUTBOX_MAX_AGE_MS * 3);
      outbox.markRowMissing('a', OUTBOX_MAX_AGE_MS * 3 + 1000);

      expect(outbox.due(OUTBOX_MAX_AGE_MS * 4).map((entry) => entry.id)).toEqual(['a']);
      outbox.due(OUTBOX_MAX_AGE_MS * 4 + 1);
      expect(outbox.size).toBe(0);
    });
  });

  describe('entries that close an event', () => {
    const fill = (count: number) => {
      for (let i = 0; i < count; i++) outbox.enqueueSave(event(`save-${i}`), undefined, i);
    };

    it('evicts a save before an older resolve', () => {
      outbox.enqueueResolve('close', 100, 0);
      fill(OUTBOX_MAX_ENTRIES - 1);

      outbox.enqueueSave(event('new'), undefined, 1);

      expect(outbox.has('close')).toBe(true);
      expect(dropped).toEqual([['save-0', 'full']]);
    });

    it('evicts a save before an older rewrite that carries a resolve', () => {
      const resolved = { ...event('close'), resolved: true } as AnomalyEvent;
      outbox.enqueueRewrite(resolved, 0);
      fill(OUTBOX_MAX_ENTRIES - 1);

      outbox.enqueueSave(event('new'), undefined, 1);

      expect(outbox.has('close')).toBe(true);
    });

    describe('with only closes left', () => {
      const fillWithCloses = () => {
        for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`close-${i}`, 100, 0);
      };

      it('evicts the oldest close to stay within the cap', () => {
        fillWithCloses();
        outbox.enqueueResolve('late', 100, 0);

        expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
        expect(outbox.has('late')).toBe(true);
        expect(dropped).toEqual([['close-0', 'full']]);
      });

      it('turns away a new save', () => {
        fillWithCloses();
        const reRaise = jest.fn();
        outbox.enqueueSave(event('late'), undefined, 0, reRaise);

        expect(outbox.has('late')).toBe(false);
        expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
        expect(dropped).toEqual([['late', 'full']]);
      });

      it('evicts a close with a callback before an older one without', () => {
        fillWithCloses();
        outbox.settle('close-999');
        outbox.enqueueResolve('raised-again', 100, 0, jest.fn());
        outbox.enqueueResolve('late', 100, 0);

        expect(dropped).toEqual([['raised-again', 'full']]);
        expect(outbox.has('close-0')).toBe(true);
      });
    });

    it('runs the callback of a resolve evicted from a full outbox of resolves', () => {
      const onDrop = jest.fn();
      outbox.enqueueResolve('close', 100, 0, onDrop);
      for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);

      outbox.enqueueResolve('new', 100, 1);

      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(dropped).toEqual([['close', 'full']]);
    });

    it('takes the callback of a repeat resolve when the first brought none', () => {
      const onDrop = jest.fn();
      outbox.enqueueResolve('close', 100, 0);
      outbox.enqueueResolve('close', 200, 0, onDrop);
      for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);

      outbox.enqueueResolve('new', 100, 1);

      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(outbox.has('close')).toBe(false);
    });

    it('keeps the callback of a resolve when a repeat brings none', () => {
      const onDrop = jest.fn();
      outbox.enqueueResolve('close', 100, 0, onDrop);
      outbox.enqueueResolve('close', 200, 0);
      for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);

      outbox.enqueueResolve('new', 100, 1);

      expect(onDrop).toHaveBeenCalledTimes(1);
    });

    it('keeps a resolve until the close age limit', () => {
      const reRaise = jest.fn();
      outbox.enqueueResolve('close', 100, 0, reRaise);

      expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS).map((entry) => entry.id)).toEqual(['close']);
      expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS + 1)).toEqual([]);
      expect(dropped).toEqual([['close', 'expired']]);
      expect(reRaise).toHaveBeenCalledTimes(1);
    });

    it('keeps a rewrite that carries a resolve until the close age limit', () => {
      const resolved = { ...event('close'), resolved: true } as AnomalyEvent;
      outbox.enqueueRewrite(resolved, 0);

      expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS).map((entry) => entry.id)).toEqual(['close']);
      expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS + 1)).toEqual([]);
    });

    describe('a pending save whose event was resolved', () => {
      const unsaved = (id: string, onDrop?: () => void) => {
        const anomaly = event(id);
        outbox.enqueueSave(anomaly, undefined, 0, onDrop);
        return anomaly;
      };

      it('expires at the close age limit without re-arming', () => {
        const onDrop = jest.fn();
        unsaved('a', onDrop).resolved = true;

        expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS).map((entry) => entry.id)).toEqual(['a']);
        expect(outbox.due(OUTBOX_CLOSE_MAX_AGE_MS + 1)).toEqual([]);
        expect(dropped).toEqual([['a', 'expired']]);
        expect(onDrop).not.toHaveBeenCalled();
      });

      it('is evicted after unresolved saves', () => {
        unsaved('a').resolved = true;
        fill(OUTBOX_MAX_ENTRIES - 1);

        outbox.enqueueSave(event('new'), undefined, 1);

        expect(outbox.has('a')).toBe(true);
        expect(dropped).toEqual([['save-0', 'full']]);
      });

      it('goes first from a full outbox of closes without re-arming', () => {
        const onDrop = jest.fn();
        unsaved('a', onDrop).resolved = true;
        for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);

        outbox.enqueueResolve('new', 100, 1);
        outbox.due(0);

        expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
        expect(dropped).toEqual([['a', 'full']]);
        expect(onDrop).not.toHaveBeenCalled();
      });

      it('never re-arms when it was resolved after being held', () => {
        const onDrop = jest.fn();
        const anomaly = unsaved('a', onDrop);
        for (let i = 1; i <= OUTBOX_MAX_ENTRIES; i++) outbox.enqueueSave(event(`s-${i}`), undefined, 0);
        expect(outbox.has('a')).toBe(false);

        anomaly.resolved = true;
        outbox.settle('s-1');
        outbox.due(0);

        expect(onDrop).not.toHaveBeenCalled();
      });
    });

    describe('a close carried by a pending save', () => {
      const evictFirst = () => {
        for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);
        outbox.enqueueResolve('new', 100, 1);
      };

      it('reports when there is no save to carry it', () => {
        expect(outbox.carryResolve('a', 100)).toBe(false);
      });

      it('resolves the pending event', () => {
        const anomaly = event('a');
        outbox.enqueueRewrite(anomaly, 0);

        expect(outbox.carryResolve('a', 100)).toBe(true);

        expect(anomaly).toMatchObject({ resolved: true, resolvedAt: 100 });
      });

      it('runs its callback, not the re-arm, when the save is evicted', () => {
        const rearm = jest.fn();
        const onCloseDrop = jest.fn();
        outbox.enqueueSave(event('a'), undefined, 0, rearm);
        outbox.carryResolve('a', 100, onCloseDrop);

        evictFirst();

        expect(onCloseDrop).toHaveBeenCalledTimes(1);
        expect(rearm).not.toHaveBeenCalled();
      });

      it('keeps its callback when a later resolve brings none', () => {
        const onCloseDrop = jest.fn();
        outbox.enqueueRewrite(event('a'), 0);
        outbox.carryResolve('a', 100, onCloseDrop);
        outbox.carryResolve('a', 200);

        evictFirst();

        expect(onCloseDrop).toHaveBeenCalledTimes(1);
      });

      it('hands its callback back when the save settles', () => {
        const onCloseDrop = jest.fn();
        outbox.enqueueRewrite(event('a'), 0);
        outbox.carryResolve('a', 100, onCloseDrop);

        expect(outbox.settleSave('a')).toBe(onCloseDrop);
      });

      it('keeps the callback of a resolve folded into a rewrite', () => {
        const onCloseDrop = jest.fn();
        outbox.enqueueResolve('a', 100, 0, onCloseDrop);
        outbox.enqueueRewrite(event('a'), 0);

        evictFirst();

        expect(onCloseDrop).toHaveBeenCalledTimes(1);
      });
    });

    it('still expires an unresolved rewrite', () => {
      outbox.enqueueRewrite(event('a'), 0);

      expect(outbox.due(OUTBOX_MAX_AGE_MS + 1)).toEqual([]);
      expect(dropped).toEqual([['a', 'expired']]);
    });
  });

  describe('re-arming the detector of a dropped save', () => {
    it('runs at once when the save expires', () => {
      const onDrop = jest.fn();
      outbox.enqueueSave(event('a'), undefined, 0, onDrop);

      outbox.due(OUTBOX_MAX_AGE_MS + 1);

      expect(onDrop).toHaveBeenCalledTimes(1);
    });

    it('stops waiting once the outbox has stayed full past the age limit', () => {
      const onDrop = jest.fn();
      outbox.enqueueSave(event('a'), undefined, 0, onDrop);
      for (let i = 1; i <= OUTBOX_MAX_ENTRIES; i++) {
        outbox.enqueueSave(event(`s-${i}`), undefined, OUTBOX_MAX_AGE_MS);
      }

      outbox.due(OUTBOX_MAX_AGE_MS);
      expect(onDrop).not.toHaveBeenCalled();

      outbox.due(OUTBOX_MAX_AGE_MS + 1);
      expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
      expect(onDrop).toHaveBeenCalledTimes(1);
    });

    it('waits for room when a full outbox evicts the save', () => {
      const onDrop = jest.fn();
      outbox.enqueueSave(event('a'), undefined, 0, onDrop);
      for (let i = 1; i <= OUTBOX_MAX_ENTRIES; i++) outbox.enqueueSave(event(`s-${i}`), undefined, 0);
      expect(outbox.has('a')).toBe(false);

      outbox.due(0);
      expect(onDrop).not.toHaveBeenCalled();

      outbox.settle('s-1');
      outbox.due(0);
      expect(onDrop).toHaveBeenCalledTimes(1);

      outbox.due(0);
      expect(onDrop).toHaveBeenCalledTimes(1);
    });

    describe('when the event moved on while the drop was held', () => {
      const holdDrop = (anomaly: AnomalyEvent, reRaise: () => void) => {
        outbox.enqueueSave(anomaly, undefined, 0, reRaise);
        for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`close-${i}`, 100, 0);
        outbox.settle('close-0');
        outbox.settle('close-1');
      };

      it('leaves an event that was saved since', () => {
        const anomaly = event('a');
        const reRaise = jest.fn();
        holdDrop(anomaly, reRaise);
        anomaly.persisted = true;

        outbox.due(0);

        expect(reRaise).not.toHaveBeenCalled();
      });

      it('leaves an event that was queued again', () => {
        const anomaly = event('a');
        const reRaise = jest.fn();
        holdDrop(anomaly, reRaise);
        outbox.enqueueRewrite(anomaly, 0);

        outbox.due(0);

        expect(reRaise).not.toHaveBeenCalled();
      });
    });

    it('cannot turn eviction into a chain of re-emits while the outbox stays full', () => {
      let reemits = 0;
      const emit = (id: string): void =>
        outbox.enqueueSave(event(id), undefined, 0, () => {
          reemits++;
          emit(`${id}+`);
        });
      for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++) emit(`detector-${i}`);

      for (let poll = 0; poll < 50; poll++) {
        outbox.enqueueSave(event(`spike-${poll}`), undefined, 0);
        outbox.due(0);
      }

      expect(reemits).toBe(0);
    });
  });

  it('drops entries past their age and returns the rest in order', () => {
    outbox.enqueueSave(event('old'), undefined, 0);
    outbox.enqueueSave(event('newer'), undefined, 1_000);
    outbox.enqueueResolve('newest', 1, 2_000);

    const due = outbox.due(OUTBOX_MAX_AGE_MS + 1);

    expect(due.map((entry) => entry.id)).toEqual(['newer', 'newest']);
    expect(dropped).toEqual([['old', 'expired']]);
  });
});
