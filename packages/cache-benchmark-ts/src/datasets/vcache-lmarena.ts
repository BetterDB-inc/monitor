import type { QueryPair } from '../types.js';
import { fetchDataset } from './loader.js';

const DATASET = 'vCache/SemBenchmarkLmArena';

export async function loadVcacheLmarena(options: {
  limit?: number;
}): Promise<QueryPair[]> {
  // Fetch raw rows — this dataset can be very large, always use a limit
  const effectiveLimit = options.limit ?? 1000;
  const rows = await fetchDataset(DATASET, 'train', effectiveLimit * 4);

  // Group prompts by equivalence class (ID_Set)
  const classes = new Map<number, string[]>();
  for (const row of rows) {
    const idSet = Number(row.ID_Set);
    const prompt = String(row.Prompt);
    if (!Number.isFinite(idSet) || !prompt) continue;
    let group = classes.get(idSet);
    if (!group) {
      group = [];
      classes.set(idSet, group);
    }
    group.push(prompt);
  }

  // Build positive pairs: all within-class combinations
  const positives: QueryPair[] = [];
  for (const [, prompts] of classes) {
    if (prompts.length < 2) continue;
    for (let i = 0; i < prompts.length; i++) {
      for (let j = i + 1; j < prompts.length; j++) {
        positives.push({
          promptA: prompts[i],
          promptB: prompts[j],
          isSemanticMatch: true,
          category: 'lmarena',
          source: 'vcache_lmarena',
        });
      }
    }
  }

  // Build negative pairs: random cross-class samples (equal count to positives)
  const allPrompts = [...classes.values()].flat();
  const classLookup = new Map<string, number>();
  for (const [id, prompts] of classes) {
    for (const p of prompts) classLookup.set(p, id);
  }

  const negatives: QueryPair[] = [];
  const targetNeg = positives.length;
  let attempts = 0;
  while (negatives.length < targetNeg && attempts < targetNeg * 10) {
    attempts++;
    const a = allPrompts[Math.floor(Math.random() * allPrompts.length)];
    const b = allPrompts[Math.floor(Math.random() * allPrompts.length)];
    if (a === b || classLookup.get(a) === classLookup.get(b)) continue;
    negatives.push({
      promptA: a,
      promptB: b,
      isSemanticMatch: false,
      category: 'lmarena',
      source: 'vcache_lmarena',
    });
  }

  // Shuffle and limit
  const combined = [...positives, ...negatives];
  shuffle(combined);
  return combined.slice(0, effectiveLimit);
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
