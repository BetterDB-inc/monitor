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

function cacheKey(text: string): string {
  return createHash('sha256').update(`${OPENAI_MODEL}\n${text}`).digest('hex');
}

// OpenAI's embeddings endpoint accepts up to 2048 inputs and ~300k tokens per
// request. Batch by both a count cap and a cumulative-char budget (~4 chars/
// token heuristic → ~150k tokens) so a batch never trips the token limit.
const MAX_BATCH_INPUTS = 256;
const MAX_BATCH_CHARS = 600_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Batching is fast enough to exceed OpenAI's tokens-per-minute (TPM) cap, which
// returns 429. Retry on 429 (honoring Retry-After / the suggested delay) and on
// transient 5xx with exponential backoff, so the embedder paces itself to the
// TPM limit instead of aborting a long run.
const MAX_RETRIES = 8;

function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
  }
  const match = body.match(/try again in ([\d.]+)(ms|s)/i);
  if (match) {
    const value = Number(match[1]);
    return match[2].toLowerCase() === 's' ? value * 1000 : value;
  }
  return Math.min(2 ** attempt * 500, 20_000);
}

async function embedInputs(apiKey: string, inputs: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input: inputs }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      // Order is not guaranteed; place each embedding at its reported index.
      const out = new Array<number[]>(inputs.length);
      for (const row of json.data) out[row.index] = row.embedding;
      return out;
    }
    const body = await res.text();
    // An input exceeds the model's token limit. The chunker bounds chunks by a
    // local token estimate, but OpenAI's tokenizer can count slightly higher, so
    // self-heal instead of aborting a long, expensive run: halve the batch to
    // isolate the offending input, then halve a lone over-long input until it
    // fits. Order is preserved so results still align with `inputs`.
    if (res.status === 400 && /maximum input length/i.test(body)) {
      if (inputs.length > 1) {
        const mid = Math.ceil(inputs.length / 2);
        const head = await embedInputs(apiKey, inputs.slice(0, mid));
        const tail = await embedInputs(apiKey, inputs.slice(mid));
        return [...head, ...tail];
      }
      if (inputs[0].length > 1) {
        const half = inputs[0].slice(0, Math.floor(inputs[0].length / 2));
        return embedInputs(apiKey, [half]);
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 300)}`);
    }
    // Add a little headroom over the suggested delay so the next request lands
    // after the rate window has actually rolled over.
    await sleep(retryDelayMs(res, body, attempt) + 250);
  }
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
      const key = cacheKey(text);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const [vec] = await embedInputs(apiKey, [text]);
      cache.set(key, vec);
      return vec;
    },
    prewarm: async (texts: string[]) => {
      // Embed only texts not already cached, in token-bounded batches, so the
      // per-entry `embed` calls during upsert all become cache hits.
      const pending = [...new Set(texts)].filter((t) => cache.get(cacheKey(t)) === undefined);
      let batch: string[] = [];
      let chars = 0;
      const drain = async (): Promise<void> => {
        if (batch.length === 0) return;
        const vecs = await embedInputs(apiKey, batch);
        batch.forEach((t, i) => cache.set(cacheKey(t), vecs[i]));
        batch = [];
        chars = 0;
      };
      for (const text of pending) {
        if (batch.length >= MAX_BATCH_INPUTS || chars + text.length > MAX_BATCH_CHARS) {
          await drain();
        }
        batch.push(text);
        chars += text.length;
      }
      await drain();
    },
    flush: () => cache.flush(),
  };
}
