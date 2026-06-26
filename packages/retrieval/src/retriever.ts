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
import {
  buildRetrievalMarker,
  REGISTRY_KEY,
  RETRIEVAL_CACHE_TYPE,
  RETRIEVAL_VERSION,
} from './discovery';
import { parsePercentIndexed, type IndexHealthSnapshot, type RecallEstimator } from './health';
import type { RetrievalMetrics, RetrievalTracer, RetrievalOperation } from './telemetry';
import { createAnalytics, NOOP_ANALYTICS, type Analytics, type AnalyticsOptions } from './analytics';

// Atomic compare-and-set for the shared registry field. REGISTRY_KEY is keyed by
// name and shared with agent-cache, so a plain HGET -> compare -> HSET/HDEL has a
// TOCTOU window in which a foreign marker written in between gets clobbered. These
// scripts collapse read-compare-write into one server-side round trip.
const REGISTER_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' and parsed.type and parsed.type ~= ARGV[3] then
    return parsed.type
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return false
`;

const UNREGISTER_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' and parsed.type == ARGV[2] then
    return redis.call('HDEL', KEYS[1], ARGV[1])
  end
end
return 0
`;

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
  recallEstimator?: RecallEstimator;
  metrics?: RetrievalMetrics;
  tracer?: RetrievalTracer;
  analytics?: AnalyticsOptions;
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
  private readonly recallEstimator?: RecallEstimator;
  private readonly metrics?: RetrievalMetrics;
  private readonly tracer?: RetrievalTracer;
  private resolvedDims?: number;
  private readonly analyticsOptions?: AnalyticsOptions;
  private analytics: Analytics = NOOP_ANALYTICS;
  private analyticsStarted = false;

  constructor(options: RetrieverOptions) {
    this.client = options.client;
    this.name = options.name;
    this.schema = options.schema;
    this.capabilities = options.capabilities;
    this.embedFn = options.embedFn;
    this.rerankFn = options.rerankFn;
    this.recallEstimator = options.recallEstimator;
    this.metrics = options.metrics;
    this.tracer = options.tracer;
    this.analyticsOptions = options.analytics;
  }

  // Fire-once: defer analytics startup to the first index-lifecycle call so the
  // real client is awaited before any event is captured (the constructor cannot
  // await). Never lets analytics break the retriever.
  private async ensureAnalyticsStarted(): Promise<void> {
    if (this.analyticsStarted) {
      return;
    }
    this.analyticsStarted = true;
    try {
      const analytics = await createAnalytics({
        apiKey: this.analyticsOptions?.apiKey,
        host: this.analyticsOptions?.host,
        disabled: this.analyticsOptions?.disabled,
      });
      this.analytics = analytics;
      await analytics.init(this.client, this.name, {
        fieldCount: this.schema.fields.length,
        vectorMetric: this.schema.vector.metric,
        vectorAlgorithm: this.schema.vector.algorithm,
        hasEmbedFn: this.embedFn !== undefined,
        hasRerankFn: this.rerankFn !== undefined,
      });
    } catch {
      this.analytics = NOOP_ANALYTICS;
    }
  }

  /** Tear down product analytics (flushes any pending events). */
  async close(): Promise<void> {
    await this.analytics.shutdown();
  }

  private async instrument<T>(operation: RetrievalOperation, fn: () => Promise<T>): Promise<T> {
    const span = this.tracer?.startSpan(`retrieval.${operation}`);
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.metrics?.observeOperation(operation, (performance.now() - start) / 1000);
      span?.end();
    }
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
    this.metrics?.recordEmbeddingCall();
    if (probe.length === 0) {
      throw new Error(
        'Cannot resolve vector dimension: embedFn returned a zero-length probe embedding',
      );
    }
    this.resolvedDims = probe.length;
    return this.resolvedDims;
  }

  async createIndex(): Promise<void> {
    await this.ensureAnalyticsStarted();
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
    try {
      await this.client.call(
        'FT.CREATE',
        ...buildFtCreateArgs(this.name, schema, this.capabilities),
      );
    } catch (err) {
      // Tolerate a concurrent creation: another worker may create the index
      // between our FT.INFO probe and this FT.CREATE (common on multi-worker
      // boot). The idempotent contract holds as long as the index exists.
      if (!String(err).toLowerCase().includes('already exists')) {
        throw err;
      }
      // This worker did not create the index — skip the telemetry event so a
      // multi-worker boot does not over-count index creation.
      return;
    }
    this.analytics.capture('index_created', { dims });
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
    this.metrics?.recordEmbeddingCall();
    if (vector.length !== dims) {
      throw new Error(
        `Embedding dimension mismatch: index expects ${dims}, embedFn returned ${vector.length}`,
      );
    }
    return vector;
  }

  async upsert(entries: UpsertEntry[]): Promise<void> {
    await this.ensureAnalyticsStarted();
    return this.instrument('upsert', () => this.upsertEntries(entries));
  }

  private async upsertEntries(entries: UpsertEntry[]): Promise<void> {
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
    await this.ensureAnalyticsStarted();
    if (ids.length === 0) {
      return;
    }
    const keys = ids.map((id) => `${keyPrefix(this.name)}${id}`);
    await this.client.call('DEL', ...keys);
  }

  async dropIndex(): Promise<void> {
    await this.ensureAnalyticsStarted();
    try {
      await this.client.call('FT.DROPINDEX', indexName(this.name));
    } catch (err) {
      if (!isIndexNotFoundError(err)) {
        throw err;
      }
    }
  }

  async describeIndex(): Promise<IndexDescription> {
    await this.ensureAnalyticsStarted();
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
    await this.ensureAnalyticsStarted();
    if (!Number.isInteger(options.k) || options.k <= 0) {
      throw new Error(`query k must be a positive integer, got: ${options.k}`);
    }
    const rerank = this.resolveRerank(options);
    return this.instrument('query', () => this.runQuery(options, rerank));
  }

  private async runQuery(
    options: QueryOptions,
    rerank: { fn: RerankFn; text: string } | null,
  ): Promise<QueryHit[]> {
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
    let result = hits;
    if (rerank !== null) {
      result = await rerank.fn(rerank.text, hits);
    }
    this.metrics?.recordQueryResults(result.length);
    return result;
  }

  async register(): Promise<void> {
    // The registry field is keyed by name and shared with agent-cache. Compare
    // the existing marker's type and write ours in a single atomic round trip
    // (REGISTER_SCRIPT) so a foreign marker can't be clobbered through a
    // check-then-act window. The script returns the foreign type when it skips.
    const marker = buildRetrievalMarker({
      name: this.name,
      version: RETRIEVAL_VERSION,
      startedAt: new Date().toISOString(),
    });
    const foreign = await this.client.call(
      'EVAL',
      REGISTER_SCRIPT,
      1,
      REGISTRY_KEY,
      this.name,
      JSON.stringify(marker),
      RETRIEVAL_CACHE_TYPE,
    );
    if (foreign !== null && foreign !== undefined) {
      console.warn(
        `retrieval discovery: registry field '${this.name}' already holds a '${String(foreign)}' marker; skipping registration`,
      );
    }
  }

  async unregister(): Promise<void> {
    // Only delete a marker we own — compared and HDEL'd in one atomic round trip
    // (UNREGISTER_SCRIPT) so we never delete a foreign cache type's field.
    await this.client.call(
      'EVAL',
      UNREGISTER_SCRIPT,
      1,
      REGISTRY_KEY,
      this.name,
      RETRIEVAL_CACHE_TYPE,
    );
  }

  async health(): Promise<IndexHealthSnapshot> {
    await this.ensureAnalyticsStarted();
    const info = (await this.client.call('FT.INFO', indexName(this.name))) as unknown[];
    const stats = parseFtInfoStats(info);
    const snapshot = {
      name: this.name,
      numDocs: stats.numDocs,
      indexingState: stats.indexingState,
      dims: parseDimensionFromInfo(info),
      percentIndexed: parsePercentIndexed(info),
    };
    let estimatedRecall: number | null = null;
    if (this.recallEstimator !== undefined) {
      estimatedRecall = this.recallEstimator(snapshot);
    }
    return { ...snapshot, estimatedRecall };
  }
}
