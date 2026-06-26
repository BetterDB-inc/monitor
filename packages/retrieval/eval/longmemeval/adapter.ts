import { decode, encode } from 'gpt-tokenizer';
import type { UpsertEntry, QueryHit } from '../../src/index';
import type { ChunkMode, LmeRecord, LmeSession } from './types';

// text-embedding-3-small accepts at most 8191 tokens per input. A char-based cap
// can't bound tokens safely (some characters encode to multiple BPE tokens), so
// budget by actual token count (cl100k_base, the model's encoding). Keep a wide
// margin under the hard limit: our local count can run slightly under OpenAI's
// own tokenizer, and decode/re-encode at split boundaries can drift, so cap well
// below 8191 (the embedder self-heals any residual over-long input). Every part
// keeps the session's session_id, so recall (which matches on session_id) is
// unaffected.
const MAX_EMBED_TOKENS = 6000;

// Conversation text can contain literal special-token strings (e.g.
// "<|endoftext|>"); encode them as ordinary text rather than throwing, matching
// how the embeddings API treats raw input.
const ENCODE_OPTS = { disallowedSpecial: new Set<string>() };

/** Token count of `text` under the embedder's encoding (cl100k_base). */
function tokenLen(text: string): number {
  return encode(text, ENCODE_OPTS).length;
}

/** Hard-slice a string into consecutive pieces each at most `budget` tokens. */
function sliceToBudget(text: string, budget: number): string[] {
  const tokens = encode(text, ENCODE_OPTS);
  if (tokens.length <= budget) return [text];
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += budget) {
    parts.push(decode(tokens.slice(i, i + budget)));
  }
  return parts;
}

/** Pack a session's turns into newline-joined chunks each within `budget` tokens. */
function packTurns(session: LmeSession, budget: number): string[] {
  const lines: string[] = [];
  for (const turn of session) {
    const line = `${turn.role}: ${turn.content}`;
    if (tokenLen(line) <= budget) {
      lines.push(line);
    } else {
      // A single turn larger than the budget is hard-sliced so it still embeds.
      lines.push(...sliceToBudget(line, budget));
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length > 0 && tokenLen(`${current}\n${line}`) > budget) {
      chunks.push(current);
      current = line;
    } else {
      current = current.length === 0 ? line : `${current}\n${line}`;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Turn a LongMemEval haystack into UpsertEntry chunks.
 * - 'session' (default): one chunk per session (turns joined); sessions longer
 *   than the embedder's input budget are split into multiple chunks that all
 *   carry the same session_id.
 * - 'turn': one chunk per turn.
 * The id encodes the session index (+ turn/part index when split); fields carry
 * the session_id tag (+ date tag when present) so recall can match evidence.
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
        const text = `${turn.role}: ${turn.content}`;
        // A single turn can exceed the embedder budget too; hard-slice it like
        // session mode so it still embeds instead of failing the chunk.
        const parts = sliceToBudget(text, MAX_EMBED_TOKENS);
        parts.forEach((part, pIdx) => {
          entries.push({
            id: parts.length === 1 ? `s${sIdx}_t${tIdx}` : `s${sIdx}_t${tIdx}_p${pIdx}`,
            text: part,
            fields: { ...baseFields },
          });
        });
      });
    } else {
      const parts = packTurns(session, MAX_EMBED_TOKENS);
      parts.forEach((text, pIdx) => {
        entries.push({
          id: parts.length === 1 ? `s${sIdx}` : `s${sIdx}_p${pIdx}`,
          text,
          fields: { ...baseFields },
        });
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
