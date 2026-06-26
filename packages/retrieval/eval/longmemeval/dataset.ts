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
): AsyncGenerator<LmeRecord> {
  if (dataPath === undefined || dataPath === '') {
    const records = await loadFixture();
    for (const record of records.slice(0, limit)) yield record;
    return;
  }
  const pipeline = createReadStream(dataPath).pipe(streamArray.withParserAsStream());
  let n = 0;
  try {
    for await (const item of pipeline as AsyncIterable<{ value: LmeRecord }>) {
      yield item.value;
      if (++n >= limit) break;
    }
  } finally {
    pipeline.destroy();
  }
}

/** Human-readable dataset label for the run banner. */
export function sourceLabel(dataPath: string | undefined): string {
  return dataPath !== undefined && dataPath !== '' ? dataPath : 'bundled fixture';
}
