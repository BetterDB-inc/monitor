import {
  encodeFloat32,
  isIndexNotFoundError,
  parseDimensionFromInfo,
  parseFtInfoStats,
} from '@betterdb/valkey-search-kit';
import type { RetrievalSchema, FtCapabilities } from './schema';
import { buildFtCreateArgs, indexName, keyPrefix, resolveVectorFieldName } from './ft-create';

export const TEXT_FIELD = '__text';

export type EmbedFn = (text: string) => Promise<number[]>;

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
  private resolvedDims?: number;

  constructor(options: RetrieverOptions) {
    this.client = options.client;
    this.name = options.name;
    this.schema = options.schema;
    this.capabilities = options.capabilities;
    this.embedFn = options.embedFn;
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
      if (field === TEXT_FIELD || field === vectorField) {
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
}
