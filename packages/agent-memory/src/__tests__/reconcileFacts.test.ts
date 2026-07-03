import { describe, it, expect } from 'vitest';
import { reconcile, applyOps } from '../reconcileFacts';
import type { Fact } from '../types';

describe('reconcile', () => {
  it('adds a fact for a subject not yet seen', () => {
    const ops = reconcile([{ subject: 'employer', statement: 'Acme' }], []);
    expect(ops).toEqual([{ type: 'add', fact: { subject: 'employer', statement: 'Acme' } }]);
  });

  it('noops when an incoming fact restates the existing statement', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme' }];
    const ops = reconcile([{ subject: 'employer', statement: 'Acme' }], existing);
    expect(ops).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('refreshes the date when the same statement is restated with a newer date', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-01-01' }];
    const ops = reconcile(
      [{ subject: 'employer', statement: 'Acme', date: '2024-06-01' }],
      existing,
    );
    expect(ops).toEqual([
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'Acme', date: '2024-06-01' },
      },
    ]);
  });

  it('noops when the same statement is restated with an equal or older date', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-06-01' }];
    const same = reconcile(
      [{ subject: 'employer', statement: 'Acme', date: '2024-06-01' }],
      existing,
    );
    expect(same).toEqual([{ type: 'noop', subject: 'employer' }]);
    const older = reconcile(
      [{ subject: 'employer', statement: 'Acme', date: '2024-01-01' }],
      existing,
    );
    expect(older).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('updates to a newer dated statement and ignores an older one', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-01-01' }];
    const newer = reconcile(
      [{ subject: 'employer', statement: 'Globex', date: '2024-06-01' }],
      existing,
    );
    expect(newer).toEqual([
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'Globex', date: '2024-06-01' },
      },
    ]);
    const older = reconcile(
      [{ subject: 'employer', statement: 'Initech', date: '2023-01-01' }],
      existing,
    );
    expect(older).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('deletes on a tombstone but noops on a stale (older-dated) tombstone', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-06-01' }];
    const live = reconcile(
      [{ subject: 'employer', statement: '', tombstone: true, date: '2024-07-01' }],
      existing,
    );
    expect(live[0].type).toBe('delete');
    const stale = reconcile(
      [{ subject: 'employer', statement: '', tombstone: true, date: '2024-01-01' }],
      existing,
    );
    expect(stale).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('folds earlier ops so a later fact in the same batch sees them', () => {
    const ops = reconcile(
      [
        { subject: 'city', statement: 'Sofia', date: '2024-01-01' },
        { subject: 'city', statement: 'Berlin', date: '2024-05-01' },
      ],
      [],
    );
    expect(ops).toEqual([
      { type: 'add', fact: { subject: 'city', statement: 'Sofia', date: '2024-01-01' } },
      {
        type: 'update',
        subject: 'city',
        fact: { subject: 'city', statement: 'Berlin', date: '2024-05-01' },
      },
    ]);
  });
});

describe('applyOps', () => {
  it('produces the curated set after add/update/delete', () => {
    const ops = reconcile(
      [
        { subject: 'employer', statement: 'Acme' },
        { subject: 'city', statement: 'Sofia' },
        { subject: 'city', statement: 'Berlin', date: '2024-05-01' },
      ],
      [],
    );
    const curated = applyOps([], ops);
    expect(curated).toEqual([
      { subject: 'employer', statement: 'Acme' },
      { subject: 'city', statement: 'Berlin', date: '2024-05-01' },
    ]);
  });

  it('drops a tombstoned subject', () => {
    const existing: Fact[] = [{ subject: 'pet', statement: 'has a dog', date: '2024-01-01' }];
    const ops = reconcile(
      [{ subject: 'pet', statement: '', tombstone: true, date: '2024-06-01' }],
      existing,
    );
    expect(applyOps(existing, ops)).toEqual([]);
  });
});
