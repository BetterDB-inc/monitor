import { AnomalyEvent } from '../types';
import {
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
    for (let i = 0; i <= OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`id-${i}`, 1, 0);

    expect(outbox.size).toBe(OUTBOX_MAX_ENTRIES);
    expect(outbox.has('id-0')).toBe(false);
    expect(dropped).toEqual([['id-0', 'full']]);
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

    it('runs the callback of a resolve evicted from a full outbox of resolves', () => {
      const onDrop = jest.fn();
      outbox.enqueueResolve('close', 100, 0, onDrop);
      for (let i = 1; i < OUTBOX_MAX_ENTRIES; i++) outbox.enqueueResolve(`r-${i}`, 100, 0);

      outbox.enqueueResolve('new', 100, 1);

      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(dropped).toEqual([['close', 'full']]);
    });

    it('does not expire a resolve', () => {
      outbox.enqueueResolve('close', 100, 0);

      expect(outbox.due(OUTBOX_MAX_AGE_MS * 24).map((entry) => entry.id)).toEqual(['close']);
      expect(dropped).toEqual([]);
    });

    it('does not expire a rewrite that carries a resolve', () => {
      const resolved = { ...event('close'), resolved: true } as AnomalyEvent;
      outbox.enqueueRewrite(resolved, 0);

      expect(outbox.due(OUTBOX_MAX_AGE_MS * 24).map((entry) => entry.id)).toEqual(['close']);
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
