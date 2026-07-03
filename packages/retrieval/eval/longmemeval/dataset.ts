import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import type { LmeRecord } from './types';

function fixturePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixture.json');
}

/** Load the bundled LongMemEval-shaped fixture (offline, deterministic). */
export async function loadFixture(): Promise<LmeRecord[]> {
  const raw = await readFile(fixturePath(), 'utf8');
  return JSON.parse(raw) as LmeRecord[];
}

/**
 * Stream records one at a time from a top-level JSON array, yielding at most
 * `limit`. Avoids reading the file into a single string (V8 caps strings near
 * 0.5 GB) and never holds every record in heap at once — required for
 * longmemeval_m (~2.7 GB). Falls back to the bundled fixture when no path.
 */
export async function* loadRecords(
  dataPath: string | undefined,
  limit: number,
  questionType?: string,
  perType?: number,
): AsyncGenerator<LmeRecord> {
  // Optional comma-separated question_type allow-list (e.g.
  // "temporal-reasoning,multi-session") so a subset can be evaluated in
  // isolation. Empty/undefined = all types. `limit` counts only kept records.
  const allow = new Set(
    (questionType ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
  );
  const allowed = (record: LmeRecord): boolean =>
    allow.size === 0 || allow.has(record.question_type);
  // Stratified mode: when perType > 0, keep up to `perType` records of EACH
  // question_type (a balanced, type-stratified slice) instead of the flat
  // `limit`. Because _m/_s are GROUPED by type on disk, a flat limit takes only
  // the first type's records; stratified sampling gives every type equal
  // representation for a paired A/B. Early-stops once every allowed type is
  // full (only possible when the allow-list is given, so the total is known).
  const stratify = perType !== undefined && perType > 0;
  const counts = new Map<string, number>();
  const keep = (record: LmeRecord): boolean => {
    if (!allowed(record)) return false;
    if (!stratify) return true;
    const seen = counts.get(record.question_type) ?? 0;
    if (seen >= (perType as number)) return false;
    counts.set(record.question_type, seen + 1);
    return true;
  };
  const stratifyDone = (): boolean =>
    stratify &&
    allow.size > 0 &&
    Array.from(allow).every((t) => (counts.get(t) ?? 0) >= (perType as number));

  if (dataPath === undefined || dataPath === '') {
    const records = await loadFixture();
    let n = 0;
    for (const record of records) {
      if (!keep(record)) continue;
      yield record;
      if (!stratify && ++n >= limit) break;
      if (stratifyDone()) break;
    }
    return;
  }
  const pipeline = createReadStream(dataPath).pipe(streamArray.withParserAsStream());
  let n = 0;
  try {
    for await (const item of pipeline as AsyncIterable<{ value: LmeRecord }>) {
      if (!keep(item.value)) continue;
      yield item.value;
      if (!stratify && ++n >= limit) break;
      if (stratifyDone()) break;
    }
  } finally {
    pipeline.destroy();
  }
}

/** Human-readable dataset label for the run banner. */
export function sourceLabel(dataPath: string | undefined): string {
  return dataPath !== undefined && dataPath !== '' ? dataPath : 'bundled fixture';
}
