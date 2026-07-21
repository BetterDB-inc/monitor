import { describe, it, expect } from 'vitest';
import { reconcile, applyOps, storedFactToFact, factContent } from '../reconcileFacts';
import type { Fact, MemoryItem } from '../types';

const storedItem = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'x',
  content: '',
  importance: 0.5,
  tags: [],
  createdAt: 0,
  lastAccessedAt: 0,
  accessCount: 0,
  ...over,
});

describe('storedFactToFact', () => {
  it('reads datedness from the date field, not a leading bracket in content', () => {
    // Dateless statement that happens to start with a bracket → stays dateless.
    expect(
      storedFactToFact(storedItem({ subject: 'goal', content: '[Q3] revenue target is 5M' })),
    ).toEqual({ subject: 'goal', statement: '[Q3] revenue target is 5M' });

    // Dated fact: date from the field, statement recovered by stripping the prefix.
    expect(
      storedFactToFact(storedItem({ subject: 'employer', content: '[2024-06] Globex', date: '2024-06' })),
    ).toEqual({ subject: 'employer', statement: 'Globex', date: '2024-06' });
  });

  it('round-trips factContent for a dateless bracketed statement', () => {
    const fact: Fact = { subject: 'goal', statement: '[Q3] revenue target is 5M' };
    // Written content is the bare statement (no date prefix), and with no date
    // field it recovers unchanged — no spurious date.
    const content = factContent(fact);
    expect(content).toBe('[Q3] revenue target is 5M');
    expect(storedFactToFact(storedItem({ subject: 'goal', content }))).toEqual(fact);
  });
});

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

  it('lets a dateless new statement win over an older dated fact', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-01-01' }];
    const ops = reconcile([{ subject: 'employer', statement: 'Globex' }], existing);
    expect(ops).toEqual([
      { type: 'update', subject: 'employer', fact: { subject: 'employer', statement: 'Globex' } },
    ]);
  });

  it('treats an empty-string date as dateless (supersedes a dated prior)', () => {
    // date: "" is dateless per factContent/storedFactToFact, so it must win over
    // a dated prior exactly like an undefined date — not sort before it.
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-01-01' }];
    const ops = reconcile([{ subject: 'employer', statement: 'Globex', date: '' }], existing);
    expect(ops).toEqual([
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'Globex', date: '' },
      },
    ]);
  });

  it('retracts on an empty-string-date tombstone (dateless, still deletes)', () => {
    const existing: Fact[] = [{ subject: 'employer', statement: 'Acme', date: '2024-06-01' }];
    const ops = reconcile(
      [{ subject: 'employer', statement: '', tombstone: true, date: '' }],
      existing,
    );
    expect(ops).toEqual([{ type: 'delete', subject: 'employer' }]);
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

  it('surfaces an unmatched tombstone (no prior fact) instead of a silent noop', () => {
    const ops = reconcile([{ subject: 'employer', statement: '', tombstone: true }], []);
    expect(ops).toEqual([{ type: 'unmatched-tombstone', subject: 'employer' }]);
    // It stores nothing, like a noop, but is distinguishable by the caller.
    expect(applyOps([], ops)).toEqual([]);
  });

  it('matches subjects case- and whitespace-insensitively', () => {
    const existing: Fact[] = [{ subject: 'Employer', statement: 'Acme', date: '2024-01' }];
    const ops = reconcile(
      [{ subject: ' employer ', statement: 'Globex', date: '2024-06' }],
      existing,
    );
    expect(ops).toEqual([
      {
        type: 'update',
        subject: ' employer ',
        fact: { subject: ' employer ', statement: 'Globex', date: '2024-06' },
      },
    ]);
  });

  it('picks the first case-variant as canonical on folded subject collisions in existing', () => {
    // Pre-case-folding data can hold "Employer" and "employer" as distinct rows
    // with different content. Both reconcile() and applyOps() must pick the
    // SAME (first) variant as canonical — if one were last-wins the caller's
    // first-wins diff would see a phantom change and delete both rows.
    const existing: Fact[] = [
      { subject: 'Employer', statement: 'Acme' },
      { subject: 'employer', statement: 'Globex' },
    ];
    const ops = reconcile([{ subject: 'employer', statement: 'Acme' }], existing);
    expect(ops).toEqual([{ type: 'noop', subject: 'employer' }]);
    expect(applyOps(existing, [])).toEqual([{ subject: 'Employer', statement: 'Acme' }]);
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
