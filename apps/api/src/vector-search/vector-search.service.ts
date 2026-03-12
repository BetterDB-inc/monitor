import { Injectable } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { VectorIndexInfo, VectorSearchResult } from '../common/types/metrics.types';

@Injectable()
export class VectorSearchService {
  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  private getCheckedClient(connectionId?: string) {
    const client = this.connectionRegistry.get(connectionId);
    if (!client.getCapabilities().hasVectorSearch) {
      throw new Error('Vector search is not available on this connection (Search module not loaded)');
    }
    return client;
  }

  async getIndexList(connectionId?: string): Promise<string[]> {
    return this.getCheckedClient(connectionId).getVectorIndexList();
  }

  async getIndexInfo(connectionId: string | undefined, indexName: string): Promise<VectorIndexInfo> {
    return this.getCheckedClient(connectionId).getVectorIndexInfo(indexName);
  }

  async search(
    connectionId: string | undefined,
    indexName: string,
    sourceKey: string,
    vectorField: string,
    k: number,
    filter?: string,
  ): Promise<{ results: VectorSearchResult[]; query: { sourceKey: string; vectorField: string; k: number; filter?: string } }> {
    const client = this.getCheckedClient(connectionId);
    const clampedK = Math.min(Math.max(k, 1), 50);

    const vectorBytes = await client.getHashFieldBuffer(sourceKey, vectorField);
    if (vectorBytes === null) {
      throw new Error(`Key '${sourceKey}' or field '${vectorField}' not found`);
    }

    const results = await client.vectorSearch(indexName, vectorField, vectorBytes, clampedK, filter);
    return { results, query: { sourceKey, vectorField, k: clampedK, filter } };
  }

  async sampleKeys(
    connectionId: string | undefined,
    indexName: string,
    cursor: string,
    limit: number,
  ): Promise<{ keys: Array<{ key: string; fields: Record<string, string> }>; cursor: string }> {
    const client = this.getCheckedClient(connectionId);
    const indexInfo = await client.getVectorIndexInfo(indexName);
    const prefix = indexInfo.indexDefinition?.prefixes?.[0];

    const vectorFieldNames = new Set(
      indexInfo.fields.filter(f => f.type === 'VECTOR').map(f => f.name),
    );

    let rawClient: ReturnType<typeof client.getClient>;
    try {
      rawClient = client.getClient();
    } catch {
      throw new Error('Key browsing is not supported on this connection type');
    }
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const [nextCursor, scannedKeys] = prefix
      ? await rawClient.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', cappedLimit)
      : await rawClient.scan(cursor, 'COUNT', cappedLimit);
    const limitedKeys = (scannedKeys as string[]).slice(0, cappedLimit);

    if (limitedKeys.length === 0) {
      return { keys: [], cursor: String(nextCursor) };
    }

    const pipeline = rawClient.pipeline();
    for (const key of limitedKeys) {
      pipeline.hgetall(key);
    }
    const pipelineResults = await pipeline.exec();

    const keys: Array<{ key: string; fields: Record<string, string> }> = [];
    for (let i = 0; i < limitedKeys.length; i++) {
      const [err, rawFields] = pipelineResults![i];
      if (err || !rawFields || typeof rawFields !== 'object' || Object.keys(rawFields as object).length === 0) {
        continue; // skip non-hash keys or empty results
      }
      const fields: Record<string, string> = {};
      for (const [fieldName, fieldValue] of Object.entries(rawFields as Record<string, string>)) {
        if (!vectorFieldNames.has(fieldName) && typeof fieldValue === 'string' && fieldValue.length < 2000) {
          fields[fieldName] = fieldValue;
        }
      }
      keys.push({ key: limitedKeys[i], fields });
    }

    return { keys, cursor: String(nextCursor) };
  }

}
