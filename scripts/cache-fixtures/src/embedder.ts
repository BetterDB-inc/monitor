import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, createReadStream, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { EmbedFn } from '@betterdb/semantic-cache';

export interface EmbedderOptions {
  ollamaUrl?: string;
  model?: string;
  cacheDir?: string;
}

interface CacheEntry {
  hash: string;
  vec: number[];
}

function defaultCacheDir(): string {
  if (process.env.CACHE_FIXTURES_EMBED_DIR) {
    return process.env.CACHE_FIXTURES_EMBED_DIR;
  }
  return resolve(process.cwd(), 'scripts', 'cache-fixtures', '.embeddings');
}

export async function createEmbedder(opts: EmbedderOptions = {}): Promise<EmbedFn & { stats: () => { hits: number; misses: number } }> {
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = opts.model ?? process.env.EMBED_MODEL ?? 'nomic-embed-text';
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const cacheFile = join(cacheDir, `${sanitize(model)}.jsonl`);

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const cache = await loadCache(cacheFile);
  let hits = 0;
  let misses = 0;

  const fn: EmbedFn = async (text: string) => {
    const hash = sha256(`${model}::${text}`);
    const cached = cache.get(hash);
    if (cached) {
      hits += 1;
      return cached;
    }
    misses += 1;
    const vec = await embedViaOllama(ollamaUrl, model, text);
    cache.set(hash, vec);
    appendFileSync(cacheFile, `${JSON.stringify({ hash, vec })}\n`);
    return vec;
  };

  const wrapper = fn as EmbedFn & { stats: () => { hits: number; misses: number } };
  wrapper.stats = () => ({ hits, misses });
  return wrapper;
}

async function embedViaOllama(baseUrl: string, model: string, text: string): Promise<number[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/embeddings`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Ollama at ${baseUrl}. Start it (\`ollama serve\`) and pull the model (\`ollama pull ${model}\`). Original error: ${errMsg(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama embed request failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) {
    throw new Error(`Ollama returned no embedding for model "${model}". Did you \`ollama pull ${model}\`?`);
  }
  return json.embedding;
}

async function loadCache(path: string): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (!existsSync(path)) {
    return map;
  }
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path) });
    rl.on('line', (line) => {
      if (line.trim().length === 0) {
        return;
      }
      try {
        const entry = JSON.parse(line) as CacheEntry;
        map.set(entry.hash, entry.vec);
      } catch {
        // skip malformed line
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', reject);
  });
  return map;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
