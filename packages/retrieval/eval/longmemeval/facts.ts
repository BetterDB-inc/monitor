import type { UpsertEntry } from '../../src/index';
import { chat } from './reader';
import type { LmeRecord, LmeSession } from './types';

const EXTRACT_MODEL = process.env.LONGMEMEVAL_FACTS_MODEL ?? 'gpt-5.4';

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

function isNewer(candidate: Fact, prior: Fact): boolean {
  return (candidate.date ?? '') >= (prior.date ?? '');
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
      if (prior === undefined) {
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

function factFields(fact: Fact): Record<string, string> {
  const fields: Record<string, string> = { session_id: fact.sessionId ?? '' };
  if (fact.date !== undefined && fact.date !== '') {
    fields.date = fact.date;
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

function parseFacts(raw: string): Fact[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
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
): Promise<{ chunks: UpsertEntry[]; llmCalls: number }> {
  let curated: Fact[] = [];
  let llmCalls = 0;
  for (let i = 0; i < record.haystack_sessions.length; i++) {
    const session = record.haystack_sessions[i];
    const sessionId = record.haystack_session_ids[i] ?? `session_${i}`;
    const date = record.haystack_dates?.[i];
    const extracted = await extract(session, { sessionId, date });
    llmCalls++;
    const stamped = extracted.map((fact) => ({ ...fact, sessionId, date: fact.date ?? date }));
    curated = applyOps(curated, reconcile(stamped, curated));
  }
  const chunks = curated.map((fact, idx) => ({
    id: `fact_${idx}`,
    text: fact.statement,
    fields: factFields(fact),
  }));
  return { chunks, llmCalls };
}
