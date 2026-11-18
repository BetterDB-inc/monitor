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

export function readMeta(file: string): TrialMeta {
  const text = gunzipSync(readFileSync(file)).toString('utf8');
  const end = text.indexOf('\n');
  return JSON.parse(end < 0 ? text : text.slice(0, end)) as TrialMeta;
}

export function recordedWith(meta: TrialMeta, wanted: { nodeTimeoutMs: number; clusterSize: number }): string | null {
  if (meta.nodeTimeoutMs !== wanted.nodeTimeoutMs) {
    return `a node timeout of ${meta.nodeTimeoutMs} ms, not ${wanted.nodeTimeoutMs} ms`;
  }
  const members = meta.nodes.filter((node) => node.role !== 'joiner').length;
  if (members !== wanted.clusterSize) return `${members} nodes, not ${wanted.clusterSize}`;
  return null;
}

export function otherSetup(dir: string, wanted: { nodeTimeoutMs: number; clusterSize: number }): string | null {
  for (const file of traceFiles(dir)) {
    const meta = readMeta(file);
    const mismatch = recordedWith(meta, wanted);
    if (mismatch) return `${meta.trial} was recorded with ${mismatch}`;
  }
  return null;
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
