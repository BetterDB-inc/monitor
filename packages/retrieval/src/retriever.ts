import {
  isIndexNotFoundError,
  parseDimensionFromInfo,
  parseFtInfoStats,
} from '@betterdb/valkey-search-kit';
import type { RetrievalSchema, FtCapabilities } from './schema';
import { buildFtCreateArgs, indexName } from './ft-create';

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
}

export class Retriever {
  private readonly client: RetrieverClient;
  private readonly name: string;
  private readonly schema: RetrievalSchema;
  private readonly capabilities?: FtCapabilities;

  constructor(options: RetrieverOptions) {
    this.client = options.client;
    this.name = options.name;
    this.schema = options.schema;
    this.capabilities = options.capabilities;
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
    await this.client.call(
      'FT.CREATE',
      ...buildFtCreateArgs(this.name, this.schema, this.capabilities),
    );
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
