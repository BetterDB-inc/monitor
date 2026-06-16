import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
 * Load the dataset: the real LongMemEval json at `dataPath` when given, else
 * the bundled fixture. Returns records plus a human-readable source label.
 */
export async function loadDataset(
  dataPath: string | undefined,
): Promise<{ records: LmeRecord[]; source: string }> {
  if (dataPath !== undefined && dataPath !== '') {
    const raw = await readFile(dataPath, 'utf8');
    return { records: JSON.parse(raw) as LmeRecord[], source: dataPath };
  }
  return { records: await loadFixture(), source: 'bundled fixture' };
}
