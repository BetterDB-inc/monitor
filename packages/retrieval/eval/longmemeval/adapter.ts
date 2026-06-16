import type { UpsertEntry, QueryHit } from '../../src/index';
import type { ChunkMode, LmeRecord, LmeSession } from './types';

function sessionText(session: LmeSession): string {
  return session.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
}

/**
 * Turn a LongMemEval haystack into UpsertEntry chunks.
 * - 'session' (default): one chunk per session (turns joined).
 * - 'turn': one chunk per turn.
 * The id encodes the session index (+ turn index for 'turn'); fields carry the
 * session_id tag (+ date tag when present) so recall can match evidence.
 */
export function chunkRecord(record: LmeRecord, mode: ChunkMode): UpsertEntry[] {
  const entries: UpsertEntry[] = [];
  record.haystack_sessions.forEach((session, sIdx) => {
    const sessionId = record.haystack_session_ids[sIdx] ?? `session_${sIdx}`;
    const date = record.haystack_dates?.[sIdx];
    const baseFields: Record<string, string> = { session_id: sessionId };
    if (date !== undefined && date !== '') {
      baseFields.date = date;
    }

    if (mode === 'turn') {
      session.forEach((turn, tIdx) => {
        entries.push({
          id: `s${sIdx}_t${tIdx}`,
          text: `${turn.role}: ${turn.content}`,
          fields: { ...baseFields },
        });
      });
    } else {
      entries.push({
        id: `s${sIdx}`,
        text: sessionText(session),
        fields: { ...baseFields },
      });
    }
  });
  return entries;
}

/** A record is a recall HIT if any retrieved chunk's session_id is evidence. */
export function recordIsHit(hits: QueryHit[], answerSessionIds: string[]): boolean {
  const evidence = new Set(answerSessionIds);
  return hits.some((hit) => evidence.has(hit.fields.session_id));
}
