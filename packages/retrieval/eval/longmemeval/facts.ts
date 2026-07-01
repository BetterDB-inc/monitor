import type { UpsertEntry } from '../../src/index';
import { chat } from './reader';
import { mapWithConcurrency } from './concurrency';
import type { LmeRecord, LmeSession } from './types';

const EXTRACT_MODEL = process.env.LONGMEMEVAL_FACTS_MODEL ?? 'gpt-5.4';
const DEFAULT_FACTS_CONCURRENCY = 8;

export interface Fact {
  subject: string;
  statement: string;
  date?: string;
  tombstone?: boolean;
  sessionId?: string;
}

export interface FactExtractorMeta {
  sessionId: string;
  date?: string;
}

export type FactExtractor = (session: LmeSession, meta: FactExtractorMeta) => Promise<Fact[]>;

export type FactOp =
  | { type: 'add'; fact: Fact }
  | { type: 'update'; subject: string; fact: Fact }
  | { type: 'delete'; subject: string }
  | { type: 'noop'; subject: string };

// Sessions are reconciled in chronological order, so a dateless candidate is
// the later assertion and wins — the same default that lets a dateless
// tombstone delete. A dateless prior likewise loses to any dated candidate.
function isNewer(candidate: Fact, prior: Fact): boolean {
  if (candidate.date === undefined || prior.date === undefined) {
    return true;
  }
  return candidate.date >= prior.date;
}

// A tombstone is stale only when both dates are known and it predates the
// curated fact; a dateless tombstone still deletes (it carries no temporal
// claim to lose against).
function isStaleTombstone(tombstone: Fact, prior: Fact): boolean {
  return tombstone.date !== undefined && prior.date !== undefined && tombstone.date < prior.date;
}

export function reconcile(incoming: Fact[], existing: Fact[]): FactOp[] {
  const bySubject = new Map<string, Fact>();
  for (const fact of existing) {
    bySubject.set(fact.subject, fact);
  }

  // Fold each op into `bySubject` as we go so later facts in the same batch see
  // earlier adds/updates/deletes — not just the initial `existing` snapshot.
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
      ops.push({ type: 'noop', subject: fact.subject });
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

function factFields(sessionId: string, date: string | undefined): Record<string, string> {
  const fields: Record<string, string> = { session_id: sessionId };
  if (date !== undefined && date !== '') {
    fields.date = date;
  }
  return fields;
}

export function createMockFactExtractor(): FactExtractor {
  return async (session, meta) => {
    const firstUser = session.find((turn) => turn.role === 'user');
    if (firstUser === undefined) {
      return [];
    }
    return [{ subject: `session_${meta.sessionId}`, statement: firstUser.content }];
  };
}

export function parseFacts(raw: string): Fact[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    // A malformed reply (or prose with stray brackets) degrades to no facts for
    // this session rather than aborting the whole eval run.
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const facts: Fact[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const subject = record.subject;
    const statement = record.statement;
    if (typeof subject === 'string' && typeof statement === 'string') {
      facts.push({ subject, statement, tombstone: record.tombstone === true });
    }
  }
  return facts;
}

export function createOpenAIFactExtractor(apiKey: string): FactExtractor {
  const system =
    'Extract durable, atomic facts about the user from the conversation session. ' +
    'Return ONLY a JSON array of objects {"subject","statement"} where subject is a ' +
    'short normalized snake_case attribute key (e.g. "employer", "home_city") and ' +
    'statement is the fact in a short sentence. Include only salient, durable facts ' +
    'a personal assistant should remember. If none, return [].';
  return async (session) => {
    const user = session.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
    const reply = await chat(apiKey, EXTRACT_MODEL, system, user);
    return parseFacts(reply);
  };
}

export async function consolidateRecordFacts(
  record: LmeRecord,
  extract: FactExtractor,
  concurrency: number = DEFAULT_FACTS_CONCURRENCY,
): Promise<{ chunks: UpsertEntry[]; llmCalls: number }> {
  // Per-session extraction is independent, so run it with bounded concurrency —
  // _m averages ~475 sessions per record, far too many to extract serially. Only
  // the reconcile pass below needs session order, so it stays sequential.
  const stampedPerSession = await mapWithConcurrency(
    record.haystack_sessions,
    concurrency,
    async (session, i) => {
      const sessionId = record.haystack_session_ids[i] ?? `session_${i}`;
      const date = record.haystack_dates?.[i];
      const extracted = await extract(session, { sessionId, date });
      return extracted.map((fact) => ({ ...fact, sessionId, date: fact.date ?? date }));
    },
  );
  const llmCalls = record.haystack_sessions.length;

  let curated: Fact[] = [];
  // Track every session that asserted a fact's CURRENT statement, mapped to that
  // session's own date. A fact restated across sessions (NOOP — same subject +
  // statement) is then findable under each source session's id (recall matches on
  // session_id) and each chunk carries that session's date (not just the first
  // assertion's), so temporal ordering matches the evidence.
  const sources = new Map<string, Map<string, string | undefined>>();
  for (const stamped of stampedPerSession) {
    const priorStatement = new Map(curated.map((fact) => [fact.subject, fact.statement]));
    curated = applyOps(curated, reconcile(stamped, curated));
    const curatedBySubject = new Map(curated.map((fact) => [fact.subject, fact]));
    for (const fact of stamped) {
      const current = curatedBySubject.get(fact.subject);
      if (current === undefined || current.statement !== fact.statement) {
        continue;
      }
      const sessionId = fact.sessionId ?? '';
      if (priorStatement.get(fact.subject) !== fact.statement) {
        sources.set(fact.subject, new Map([[sessionId, fact.date]]));
      } else {
        const seen = sources.get(fact.subject) ?? new Map<string, string | undefined>();
        seen.set(sessionId, fact.date);
        sources.set(fact.subject, seen);
      }
    }
  }
  const chunks: UpsertEntry[] = [];
  let idx = 0;
  for (const fact of curated) {
    const seen = sources.get(fact.subject) ?? new Map([[fact.sessionId ?? '', fact.date]]);
    for (const [sessionId, sessionDate] of seen) {
      chunks.push({
        id: `fact_${idx}`,
        text: fact.statement,
        fields: factFields(sessionId, sessionDate),
      });
      idx++;
    }
  }
  return { chunks, llmCalls };
}
