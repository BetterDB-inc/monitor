import type { Fact, MemoryItem } from './types';

/** Render a fact's content for storage, preserving its asserted date as a prefix. */
export function factContent(fact: Fact): string {
  return fact.date !== undefined && fact.date !== ''
    ? `[${fact.date}] ${fact.statement}`
    : fact.statement;
}

/**
 * Recover a {@link Fact} from a stored fact memory. Datedness is read from the
 * persisted `date` field (the source of truth), NOT inferred from a leading
 * bracket in the content — otherwise a dateless statement like
 * "[Q3] revenue target is 5M" would round-trip into a spurious dated fact and
 * corrupt newest-wins resolution. When a date is present the content was written
 * as `[date] statement`, so the known prefix is stripped to recover the
 * statement (inverse of {@link factContent}).
 */
export function storedFactToFact(item: MemoryItem): Fact {
  const subject = item.subject ?? '';
  const date = item.date;
  if (date === undefined || date === '') {
    return { subject, statement: item.content };
  }
  const prefix = `[${date}] `;
  const statement = item.content.startsWith(prefix)
    ? item.content.slice(prefix.length)
    : item.content;
  return { subject, statement, date };
}

/**
 * A single reconciliation decision for one incoming fact against the curated
 * set: add a new subject, update it to a newer statement, delete it (tombstone),
 * or leave it unchanged.
 */
export type FactOp =
  | { type: 'add'; fact: Fact }
  | { type: 'update'; subject: string; fact: Fact }
  | { type: 'delete'; subject: string }
  | { type: 'noop'; subject: string }
  // A tombstone whose subject matched no prior fact. It stores nothing (like a
  // noop) but is surfaced separately so the caller can log it instead of losing
  // it silently — a model that mislabels a live fact as a tombstone shows up here.
  | { type: 'unmatched-tombstone'; subject: string };

/**
 * Match key for a subject: case- and whitespace-insensitive, so "Dashboard theme"
 * and "dashboard theme" reconcile to the same fact. Only the match key is folded;
 * the stored fact keeps its original subject casing.
 */
export function subjectKey(subject: string): string {
  return subject.trim().toLowerCase();
}

// Datedness is "has a non-empty date". An empty string is treated as dateless,
// consistent with factContent/storedFactToFact/buildMemoryRecord — so a fact
// with date: "" behaves identically to one with no date at all.
function factDate(fact: Fact): string | undefined {
  return fact.date === undefined || fact.date === '' ? undefined : fact.date;
}

// A dateless candidate is the latest assertion we have, so it wins ties (and
// any dated prior). A dated candidate wins when its date is at least the
// prior's (a dateless prior counts as the epoch, so any dated candidate beats
// it, and equal dates let the later batch assertion win).
function isNewer(candidate: Fact, prior: Fact): boolean {
  const candidateDate = factDate(candidate);
  if (candidateDate === undefined) {
    return true;
  }
  return candidateDate >= (factDate(prior) ?? '');
}

// A tombstone is stale only when both dates are known and it predates the
// curated fact; a dateless tombstone still deletes (it carries no temporal
// claim to lose against).
function isStaleTombstone(tombstone: Fact, prior: Fact): boolean {
  const tombstoneDate = factDate(tombstone);
  const priorDate = factDate(prior);
  return tombstoneDate !== undefined && priorDate !== undefined && tombstoneDate < priorDate;
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
    bySubject.set(subjectKey(fact.subject), fact);
  }

  const ops: FactOp[] = [];
  for (const fact of incoming) {
    const key = subjectKey(fact.subject);
    const prior = bySubject.get(key);
    if (fact.tombstone === true) {
      if (prior === undefined) {
        // No live fact to retract: surface it rather than silently swallow it.
        ops.push({ type: 'unmatched-tombstone', subject: fact.subject });
      } else if (isStaleTombstone(fact, prior)) {
        ops.push({ type: 'noop', subject: fact.subject });
      } else {
        ops.push({ type: 'delete', subject: fact.subject });
        bySubject.delete(key);
      }
      continue;
    }
    if (prior === undefined) {
      ops.push({ type: 'add', fact });
      bySubject.set(key, fact);
      continue;
    }
    if (prior.statement === fact.statement) {
      // Same claim restated: refresh only when this assertion carries a
      // strictly newer date, so newest-date-wins still governs the stored
      // [date] prefix. Equal/older/dateless restatements stay a noop (no
      // content change to rewrite).
      if ((factDate(fact) ?? '') > (factDate(prior) ?? '')) {
        ops.push({ type: 'update', subject: fact.subject, fact });
        bySubject.set(key, fact);
      } else {
        ops.push({ type: 'noop', subject: fact.subject });
      }
      continue;
    }
    if (isNewer(fact, prior)) {
      ops.push({ type: 'update', subject: fact.subject, fact });
      bySubject.set(key, fact);
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
    bySubject.set(subjectKey(fact.subject), fact);
  }
  for (const op of ops) {
    if (op.type === 'add') {
      bySubject.set(subjectKey(op.fact.subject), op.fact);
    } else if (op.type === 'update') {
      bySubject.set(subjectKey(op.subject), op.fact);
    } else if (op.type === 'delete') {
      bySubject.delete(subjectKey(op.subject));
    }
    // 'noop' and 'unmatched-tombstone' change nothing in the curated set.
  }
  return [...bySubject.values()];
}
