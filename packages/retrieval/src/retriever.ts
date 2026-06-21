import {
  encodeFloat32,
  isIndexNotFoundError,
  parseDimensionFromInfo,
  parseFtInfoStats,
  parseFtSearchResponse,
  type FtSearchHit,
} from '@betterdb/valkey-search-kit';
import type { RetrievalSchema, FtCapabilities } from './schema';
import { buildFtCreateArgs, indexName, keyPrefix, resolveVectorFieldName } from './ft-create';
import { buildFtSearchQuery, type QueryFilter } from './ft-search';
import { TEXT_FIELD, SCORE_FIELD, RESERVED_FIELD_NAMES } from './fields';

export type EmbedFn = (text: string) => Promise<number[]>;

export type RerankFn = (queryText: string, hits: QueryHit[]) => Promise<QueryHit[]>;

export interface QueryHit {
  id: string;
  /**
   * Raw KNN `__score` from valkey-search: a vector **distance**, not a
   * similarity. Lower means closer (a perfect match approaches 0), so rank
   * ascending. Do not assume higher is better.
   */
  score: number;
  text: string;
  fields: Record<string, string>;
}

export interface QueryOptions {
  text?: string;
  vector?: number[];
  k: number;
  filter?: QueryFilter;
  hybrid?: 'rerank';
}

export interface RetrieverClient {
  call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown>;
}

export interface IndexDescription {
  name: string;
  dims: number;
  numDocs: number;
  indexingState: string;
}

export interface RetrieverOptions {
  client: RetrieverClient;
  name: string;
  schema: RetrievalSchema;
  capabilities?: FtCapabilities;
  embedFn?: EmbedFn;
  rerankFn?: RerankFn;
}

export interface UpsertEntry {
  id: string;
  text: string;
  fields: Record<string, string | number>;
}

export class Retriever {
  private readonly client: RetrieverClient;
  private readonly name: string;
  private readonly schema: RetrievalSchema;
  private readonly capabilities?: FtCapabilities;
  private readonly embedFn?: EmbedFn;
  private readonly rerankFn?: RerankFn;
  private resolvedDims?: number;

  constructor(options: RetrieverOptions) {
    this.client = options.client;
    this.name = options.name;
    this.schema = options.schema;
    this.capabilities = options.capabilities;
    this.embedFn = options.embedFn;
    this.rerankFn = options.rerankFn;
  }

  private async resolveDims(): Promise<number> {
    const declared = this.schema.vector.dims;
    if (declared !== undefined) {
      if (!Number.isInteger(declared) || declared <= 0) {
        throw new Error(`schema.vector.dims must be a positive integer, got: ${declared}`);
      }
      return declared;
    }
    if (this.resolvedDims !== undefined) {
      return this.resolvedDims;
    }
    if (this.embedFn === undefined) {
      throw new Error('Cannot resolve vector dimension: provide schema.vector.dims or an embedFn');
    }
    const probe = await this.embedFn('probe');
    if (probe.length === 0) {
      throw new Error(
        'Cannot resolve vector dimension: embedFn returned a zero-length probe embedding',
      );
    }
    this.resolvedDims = probe.length;
    return this.resolvedDims;
  }

  async createIndex(): Promise<void> {
    try {
      await this.client.call('FT.INFO', indexName(this.name));
      return;
    } catch (err) {
      if (!isIndexNotFoundError(err)) {
        throw err;
      }
    }
    const dims = await this.resolveDims();
    const schema: RetrievalSchema = {
      ...this.schema,
      vector: { ...this.schema.vector, dims },
    };
    await this.client.call('FT.CREATE', ...buildFtCreateArgs(this.name, schema, this.capabilities));
  }

  private assertNoReservedFields(entry: UpsertEntry, vectorField: string): void {
    for (const field of Object.keys(entry.fields)) {
      if (RESERVED_FIELD_NAMES.includes(field) || field === vectorField) {
        throw new Error(
          `Entry '${entry.id}' uses reserved field name '${field}'; choose a different field name`,
        );
      }
    }
  }

  private async embed(text: string): Promise<number[]> {
    if (this.embedFn === undefined) {
      throw new Error('Cannot embed text: provide an embedFn');
    }
    const dims = await this.resolveDims();
    const vector = await this.embedFn(text);
    if (vector.length !== dims) {
      throw new Error(
        `Embedding dimension mismatch: index expects ${dims}, embedFn returned ${vector.length}`,
      );
    }
    return vector;
  }

  async upsert(entries: UpsertEntry[]): Promise<void> {
    const vectorField = resolveVectorFieldName(this.schema.vector);
    const writes: { key: string; args: (string | Buffer)[] }[] = [];
    for (const entry of entries) {
      this.assertNoReservedFields(entry, vectorField);
      const vector = await this.embed(entry.text);
      const args: (string | Buffer)[] = [];
      for (const [field, value] of Object.entries(entry.fields)) {
        args.push(field, String(value));
      }
      args.push(vectorField, encodeFloat32(vector));
      args.push(TEXT_FIELD, entry.text);
      writes.push({ key: `${keyPrefix(this.name)}${entry.id}`, args });
    }
    for (const write of writes) {
      await this.client.call('HSET', write.key, ...write.args);
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const keys = ids.map((id) => `${keyPrefix(this.name)}${id}`);
    await this.client.call('DEL', ...keys);
  }

  async dropIndex(): Promise<void> {
    try {
      await this.client.call('FT.DROPINDEX', indexName(this.name));
    } catch (err) {
      if (!isIndexNotFoundError(err)) {
        throw err;
      }
    }
  }

  async describeIndex(): Promise<IndexDescription> {
    const info = (await this.client.call('FT.INFO', indexName(this.name))) as unknown[];
    const stats = parseFtInfoStats(info);
    return {
      name: this.name,
      dims: parseDimensionFromInfo(info),
      numDocs: stats.numDocs,
      indexingState: stats.indexingState,
    };
  }

  private knownDims(): number | undefined {
    const declared = this.schema.vector.dims;
    if (declared !== undefined && Number.isInteger(declared) && declared > 0) {
      return declared;
    }
    return this.resolvedDims;
  }

  private async queryVectorDims(): Promise<number | undefined> {
    const known = this.knownDims();
    if (known !== undefined) {
      return known;
    }
    if (this.embedFn === undefined) {
      return undefined;
    }
    return this.resolveDims();
  }

  private async resolveQueryVector(options: QueryOptions): Promise<number[]> {
    if (options.vector !== undefined && options.text !== undefined) {
      throw new Error('query accepts either text or a precomputed vector, not both');
    }
    if (options.vector !== undefined) {
      const dims = await this.queryVectorDims();
      if (dims !== undefined && options.vector.length !== dims) {
        throw new Error(
          `Query vector dimension mismatch: index expects ${dims}, got ${options.vector.length}`,
        );
      }
      return options.vector;
    }
    if (options.text !== undefined) {
      return this.embed(options.text);
    }
    throw new Error('query requires either text or a precomputed vector');
  }

  private mapHit(hit: FtSearchHit): QueryHit {
    const prefix = keyPrefix(this.name);
    let id = hit.key;
    if (hit.key.startsWith(prefix)) {
      id = hit.key.slice(prefix.length);
    }
    const vectorField = resolveVectorFieldName(this.schema.vector);
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(hit.fields)) {
      if (field === TEXT_FIELD || field === SCORE_FIELD || field === vectorField) {
        continue;
      }
      fields[field] = value;
    }
    return {
      id,
      score: Number(hit.fields[SCORE_FIELD]),
      text: hit.fields[TEXT_FIELD] ?? '',
      fields,
    };
  }

  private resolveRerank(options: QueryOptions): { fn: RerankFn; text: string } | null {
    if (options.hybrid !== 'rerank') {
      return null;
    }
    if (this.rerankFn === undefined) {
      throw new Error("query({ hybrid: 'rerank' }) requires a rerankFn");
    }
    if (options.text === undefined) {
      throw new Error("query({ hybrid: 'rerank' }) requires text to rerank against");
    }
    return { fn: this.rerankFn, text: options.text };
  }

  async query(options: QueryOptions): Promise<QueryHit[]> {
    if (!Number.isInteger(options.k) || options.k <= 0) {
      throw new Error(`query k must be a positive integer, got: ${options.k}`);
    }
    const rerank = this.resolveRerank(options);
    const vector = await this.resolveQueryVector(options);
    const queryString = buildFtSearchQuery(this.schema, options.k, options.filter);
    const raw = await this.client.call(
      'FT.SEARCH',
      indexName(this.name),
      queryString,
      'PARAMS',
      '2',
      'vec',
      encodeFloat32(vector),
      'LIMIT',
      '0',
      String(options.k),
      'DIALECT',
      '2',
    );
    const hits = parseFtSearchResponse(raw).map((hit) => this.mapHit(hit));
    if (rerank !== null) {
      return rerank.fn(rerank.text, hits);
    }
    return hits;
  }
}
