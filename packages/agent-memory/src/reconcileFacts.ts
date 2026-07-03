import type { Fact } from './types';

/**
 * A single reconciliation decision for one incoming fact against the curated
 * set: add a new subject, update it to a newer statement, delete it (tombstone),
 * or leave it unchanged.
 */
export type FactOp =
  | { type: 'add'; fact: Fact }
  | { type: 'update'; subject: string; fact: Fact }
  | { type: 'delete'; subject: string }
  | { type: 'noop'; subject: string };

// A dateless fact is treated as "at least as new" as any prior so a later
// assertion wins ties; when both dates are known, the newer (or equal) one wins.
function isNewer(candidate: Fact, prior: Fact): boolean {
  return (candidate.date ?? '') >= (prior.date ?? '');
}

// A tombstone is stale only when both dates are known and it predates the
// curated fact; a dateless tombstone still deletes (it carries no temporal
// claim to lose against).
function isStaleTombstone(tombstone: Fact, prior: Fact): boolean {
  return tombstone.date !== undefined && prior.date !== undefined && tombstone.date < prior.date;
}

/**
 * Reconcile a batch of `incoming` facts against the `existing` curated set,
 * returning the ordered ops that transform one into the other. Facts are keyed
 * by `subject`: a newer statement updates, an equal one is a noop, a tombstone
 * deletes (unless stale). Ops fold into the working set as they are produced so
 * later facts in the same batch see earlier decisions.
 */
export function reconcile(incoming: Fact[], existing: Fact[]): FactOp[] {
  const bySubject = new Map<string, Fact>();
  for (const fact of existing) {
    bySubject.set(fact.subject, fact);
  }

  const ops: FactOp[] = [];
  for (const fact of incoming) {
    const prior = bySubject.get(fact.subject);
    if (fact.tombstone === true) {
      if (prior === undefined || isStaleTombstone(fact, prior)) {
        ops.push({ type: 'noop', subject: fact.subject });
      } else {
        ops.push({ type: 'delete', subject: fact.subject });
        bySubject.delete(fact.subject);
      }
      continue;
    }
    if (prior === undefined) {
      ops.push({ type: 'add', fact });
      bySubject.set(fact.subject, fact);
      continue;
    }
    if (prior.statement === fact.statement) {
      // Same claim restated: refresh only when this assertion carries a
      // strictly newer date, so newest-date-wins still governs the stored
      // [date] prefix. Equal/older/dateless restatements stay a noop (no
      // content change to rewrite).
      if ((fact.date ?? '') > (prior.date ?? '')) {
        ops.push({ type: 'update', subject: fact.subject, fact });
        bySubject.set(fact.subject, fact);
      } else {
        ops.push({ type: 'noop', subject: fact.subject });
      }
      continue;
    }
    if (isNewer(fact, prior)) {
      ops.push({ type: 'update', subject: fact.subject, fact });
      bySubject.set(fact.subject, fact);
      continue;
    }
    ops.push({ type: 'noop', subject: fact.subject });
  }
  return ops;
}

/** Apply reconciliation ops to the `existing` set, returning the curated facts. */
export function applyOps(existing: Fact[], ops: FactOp[]): Fact[] {
  const bySubject = new Map<string, Fact>();
  for (const fact of existing) {
    bySubject.set(fact.subject, fact);
  }
  for (const op of ops) {
    if (op.type === 'add') {
      bySubject.set(op.fact.subject, op.fact);
    } else if (op.type === 'update') {
      bySubject.set(op.subject, op.fact);
    } else if (op.type === 'delete') {
      bySubject.delete(op.subject);
    }
  }
  return [...bySubject.values()];
}
