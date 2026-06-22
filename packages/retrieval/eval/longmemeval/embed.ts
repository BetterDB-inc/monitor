import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Embedder } from './types';

const MOCK_DIM = 256;
const OPENAI_MODEL = 'text-embedding-3-small';
const OPENAI_DIM = 1536;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * Deterministic hashed bag-of-words embedding. Each token is hashed into a few
 * fixed dimensions; lexical overlap raises cosine similarity. Enough to prove
 * ranking, not a real semantic score. No network, no keys.
 */
export function createMockEmbedder(dim = MOCK_DIM): Embedder {
  return {
    name: `mock-hashed-bow(dim=${dim})`,
    dims: dim,
    embed: async (text: string) => {
      const vec = new Array<number>(dim).fill(0);
      for (const token of tokenize(text)) {
        const h = createHash('sha256').update(token).digest();
        // Spread each token across 4 slots with signed weights.
        for (let s = 0; s < 4; s++) {
          const idx = h.readUInt32LE(s * 4) % dim;
          const sign = (h[s * 4 + 3] & 1) === 0 ? 1 : -1;
          vec[idx] += sign;
        }
      }
      return l2normalize(vec);
    },
  };
}

interface EmbedCache {
  get(key: string): number[] | undefined;
  set(key: string, vec: number[]): void;
  flush(): Promise<void>;
}

async function loadCache(path: string): Promise<EmbedCache> {
  let map = new Map<string, number[]>();
  let dirty = false;
  try {
    const raw = await readFile(path, 'utf8');
    map = new Map(Object.entries(JSON.parse(raw) as Record<string, number[]>));
  } catch {
    // No cache yet; start empty.
  }
  return {
    get: (key) => map.get(key),
    set: (key, vec) => {
      map.set(key, vec);
      dirty = true;
    },
    flush: async () => {
      if (!dirty) return;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(Object.fromEntries(map)));
        dirty = false;
      } catch (err) {
        // The on-disk cache is only a cost optimization. At large scale the map
        // can exceed V8's max string length when serialized; never let a flush
        // failure discard an otherwise-completed eval — warn and continue.
        console.warn(`embedding cache flush skipped: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Real OpenAI text-embedding-3-small (1536 dims) with an on-disk,
 * content-addressed cache so re-runs are cheap and indexing isn't re-billed.
 */
export async function createOpenAIEmbedder(
  apiKey: string,
  cachePath: string,
): Promise<Embedder> {
  const cache = await loadCache(cachePath);
  return {
    name: `openai:${OPENAI_MODEL}`,
    dims: OPENAI_DIM,
    embed: async (text: string) => {
      const key = createHash('sha256').update(`${OPENAI_MODEL}\n${text}`).digest('hex');
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: OPENAI_MODEL, input: text }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      const vec = json.data[0].embedding;
      cache.set(key, vec);
      return vec;
    },
    flush: () => cache.flush(),
  };
}
