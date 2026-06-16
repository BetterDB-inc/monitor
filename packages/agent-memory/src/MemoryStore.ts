import { randomUUID } from 'node:crypto';
import { buildMemoryRecord } from './buildMemoryRecord';
import type { EmbedFn, MemoryStoreClient, RememberOptions } from './types';

export interface MemoryStoreOptions {
  client: MemoryStoreClient;
  name: string;
  embedFn: EmbedFn;
}

export class MemoryStore {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly embedFn: EmbedFn;
  private dims?: number;

  constructor(options: MemoryStoreOptions) {
    this.client = options.client;
    this.name = options.name;
    this.embedFn = options.embedFn;
  }

  async remember(content: string, options: RememberOptions = {}): Promise<string> {
    const vector = await this.embed(content);
    const id = randomUUID();
    const now = Date.now();
    const record = buildMemoryRecord(this.name, id, content, vector, options, now);
    await this.client.call('HSET', record.key, ...record.fields);
    return id;
  }

  private async embed(content: string): Promise<number[]> {
    const vector = await this.embedFn(content);
    if (this.dims === undefined) {
      this.dims = vector.length;
    } else if (vector.length !== this.dims) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dims}, embedFn returned ${vector.length}`,
      );
    }
    return vector;
  }
}
