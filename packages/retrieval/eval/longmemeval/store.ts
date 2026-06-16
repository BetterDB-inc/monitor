import type { RetrieverClient } from '../../src/index';
import type { Store } from './types';

type FieldType = 'tag' | 'numeric' | 'text' | 'vector';

interface IndexConfig {
  name: string;
  prefix: string;
  vectorField: string;
  dims: number;
  fieldTypes: Record<string, FieldType>;
}

function decodeFloat32(value: unknown): number[] {
  if (!Buffer.isBuffer(value)) {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i + 4 <= value.length; i += 4) {
    out.push(value.readFloatLE(i));
  }
  return out;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}

function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

interface ParsedQuery {
  k: number;
  scoreField: string;
  tagFilters: { field: string; value: string }[];
  numericFilters: { field: string; value: number }[];
}

function parseQuery(queryString: string): ParsedQuery {
  const knn = /\[KNN (\d+) @(\S+) \$vec AS (\S+)\]/.exec(queryString);
  if (knn === null) {
    throw new Error(`Mock FT.SEARCH could not parse KNN clause: ${queryString}`);
  }
  const k = parseInt(knn[1], 10);
  const scoreField = knn[3];

  const filterExpr = queryString.slice(0, queryString.indexOf('=>'));
  const tagFilters: { field: string; value: string }[] = [];
  const numericFilters: { field: string; value: number }[] = [];

  if (filterExpr.trim() !== '*') {
    const tagRe = /@(\w+):\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(filterExpr)) !== null) {
      tagFilters.push({ field: m[1], value: unescapeTag(m[2]) });
    }
    const numRe = /@(\w+):\[(\S+) (\S+)\]/g;
    while ((m = numRe.exec(filterExpr)) !== null) {
      numericFilters.push({ field: m[1], value: parseFloat(m[2]) });
    }
  }

  return { k, scoreField, tagFilters, numericFilters };
}

/**
 * In-memory store that implements the subset of the valkey-search command
 * surface the Retriever uses. FT.SEARCH parses the query string the SDK builds,
 * decodes the Float32 PARAMS vector, computes cosine distance to every stored
 * vector, applies tag/numeric filters and returns the top-k in the exact reply
 * shape parseFtSearchResponse expects. Behaves like FLAT-exact (≈ HNSW on small
 * data), and is fully synchronous so Tier 0 is deterministic.
 */
class MockRetrieverClient implements RetrieverClient {
  private readonly indexes = new Map<string, IndexConfig>();
  private readonly hashes = new Map<string, Map<string, string | Buffer>>();

  async call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown> {
    switch (command.toUpperCase()) {
      case 'HSET':
        return this.hset(args);
      case 'DEL':
        return this.del(args);
      case 'HDEL':
        return this.hdel(args);
      case 'FT.CREATE':
        return this.ftCreate(args);
      case 'FT.INFO':
        return this.ftInfo(args);
      case 'FT.DROPINDEX':
        return this.ftDropIndex(args);
      case 'FT._LIST':
        return Array.from(this.indexes.keys());
      case 'FT.SEARCH':
        return this.ftSearch(args);
      default:
        throw new Error(`MockRetrieverClient: unsupported command ${command}`);
    }
  }

  private hset(args: (string | Buffer | number)[]): number {
    const key = String(args[0]);
    let map = this.hashes.get(key);
    if (map === undefined) {
      map = new Map();
      this.hashes.set(key, map);
    }
    for (let i = 1; i + 1 < args.length; i += 2) {
      const field = String(args[i]);
      const value = args[i + 1];
      map.set(field, Buffer.isBuffer(value) ? value : String(value));
    }
    return 1;
  }

  private del(args: (string | Buffer | number)[]): number {
    let removed = 0;
    for (const arg of args) {
      if (this.hashes.delete(String(arg))) {
        removed++;
      }
    }
    return removed;
  }

  private hdel(args: (string | Buffer | number)[]): number {
    const key = String(args[0]);
    const map = this.hashes.get(key);
    if (map === undefined) return 0;
    let removed = 0;
    for (let i = 1; i < args.length; i++) {
      if (map.delete(String(args[i]))) removed++;
    }
    return removed;
  }

  private ftCreate(args: (string | Buffer | number)[]): string {
    const tokens = args.map(String);
    const name = tokens[0];
    const prefixIdx = tokens.indexOf('PREFIX');
    const prefix = tokens[prefixIdx + 2];
    const schemaIdx = tokens.indexOf('SCHEMA');
    const fieldTypes: Record<string, FieldType> = {};
    let vectorField = 'embedding';
    let dims = 0;

    let i = schemaIdx + 1;
    while (i < tokens.length) {
      const fieldName = tokens[i];
      const type = tokens[i + 1];
      i += 2;
      if (type === 'TAG') {
        fieldTypes[fieldName] = 'tag';
        if (tokens[i] === 'SEPARATOR') i += 2;
      } else if (type === 'NUMERIC') {
        fieldTypes[fieldName] = 'numeric';
        if (tokens[i] === 'SORTABLE') i += 1;
      } else if (type === 'TEXT') {
        fieldTypes[fieldName] = 'text';
      } else if (type === 'VECTOR') {
        fieldTypes[fieldName] = 'vector';
        vectorField = fieldName;
        const count = parseInt(tokens[i + 1], 10);
        const pairStart = i + 2;
        for (let j = pairStart; j < pairStart + count; j += 2) {
          if (tokens[j] === 'DIM') {
            dims = parseInt(tokens[j + 1], 10);
          }
        }
        i = pairStart + count;
      } else {
        // Unknown token; skip defensively.
        i += 1;
      }
    }

    this.indexes.set(name, { name, prefix, vectorField, dims, fieldTypes });
    return 'OK';
  }

  private requireIndex(name: string): IndexConfig {
    const cfg = this.indexes.get(name);
    if (cfg === undefined) {
      throw new Error(`Unknown index name: ${name}`);
    }
    return cfg;
  }

  private docsForIndex(cfg: IndexConfig): [string, Map<string, string | Buffer>][] {
    return Array.from(this.hashes.entries()).filter(([key]) => key.startsWith(cfg.prefix));
  }

  private ftInfo(args: (string | Buffer | number)[]): unknown[] {
    const name = String(args[0]);
    const cfg = this.requireIndex(name);
    const numDocs = this.docsForIndex(cfg).length;
    return [
      'index_name',
      name,
      'num_docs',
      String(numDocs),
      'indexing',
      '0',
      'percent_indexed',
      '1',
      'attributes',
      [['identifier', cfg.vectorField, 'type', 'VECTOR', 'dim', String(cfg.dims)]],
    ];
  }

  private ftDropIndex(args: (string | Buffer | number)[]): string {
    const name = String(args[0]);
    this.requireIndex(name);
    this.indexes.delete(name);
    return 'OK';
  }

  private ftSearch(args: (string | Buffer | number)[]): unknown[] {
    const name = String(args[0]);
    const cfg = this.requireIndex(name);
    const queryString = String(args[1]);
    const parsed = parseQuery(queryString);

    const vecIdx = args.findIndex((a) => a === 'vec');
    const queryVec = decodeFloat32(args[vecIdx + 1]);

    const scored: { key: string; map: Map<string, string | Buffer>; distance: number }[] = [];
    for (const [key, map] of this.docsForIndex(cfg)) {
      let pass = true;
      for (const f of parsed.tagFilters) {
        if (String(map.get(f.field) ?? '') !== f.value) {
          pass = false;
          break;
        }
      }
      if (pass) {
        for (const f of parsed.numericFilters) {
          if (Number(map.get(f.field)) !== f.value) {
            pass = false;
            break;
          }
        }
      }
      if (!pass) continue;
      const docVec = decodeFloat32(map.get(cfg.vectorField));
      scored.push({ key, map, distance: cosineDistance(queryVec, docVec) });
    }

    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, parsed.k);

    const reply: unknown[] = [top.length];
    for (const hit of top) {
      const fieldArray: string[] = [];
      for (const [field, value] of hit.map.entries()) {
        if (field === cfg.vectorField) continue;
        fieldArray.push(field, value.toString());
      }
      fieldArray.push(parsed.scoreField, String(hit.distance));
      reply.push(hit.key, fieldArray);
    }
    return reply;
  }
}

export function createMockStore(): Store {
  return {
    name: 'mock-in-memory',
    isReal: false,
    client: new MockRetrieverClient(),
    close: async () => {},
  };
}

/**
 * Real valkey-search store via iovalkey. Returns null if the server is
 * unreachable or the search module (FT._LIST) is absent, so callers can fall
 * back to the mock store gracefully (same skip-guard as Phase 6).
 */
export async function createRealStore(url: string): Promise<Store | null> {
  const { default: Valkey } = await import('iovalkey');
  const client = new Valkey(url, { lazyConnect: true, retryStrategy: () => null });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.ping();
    await client.call('FT._LIST');
  } catch {
    await client.quit().catch(() => {});
    return null;
  }
  return {
    name: `valkey-search@${url.replace(/:[^:@/]*@/, ':***@')}`,
    isReal: true,
    client: client as unknown as Store['client'],
    close: async () => {
      await client.quit().catch(() => {});
    },
  };
}
