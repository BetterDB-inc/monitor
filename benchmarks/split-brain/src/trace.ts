import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Tick } from './recorder';
import type { TrialMeta } from './scenarios';

export interface Trace {
  meta: TrialMeta;
  ticks: Tick[];
}

export function readTrace(file: string): Trace {
  const [head, ...rest] = gunzipSync(readFileSync(file)).toString('utf8').split('\n');
  return { meta: JSON.parse(head) as TrialMeta, ticks: rest.map((line) => JSON.parse(line) as Tick) };
}

export function traceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...traceFiles(path));
    else if (entry.endsWith('.jsonl.gz')) found.push(path);
  }
  return found.sort();
}
