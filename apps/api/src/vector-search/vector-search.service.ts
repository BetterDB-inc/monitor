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

  async getIndexInfo(connectionId?: string, indexName?: string): Promise<VectorIndexInfo> {
    return this.getCheckedClient(connectionId).getVectorIndexInfo(indexName!);
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

    const rawClient = client.getClient();
    const vectorBytes = await rawClient.hgetBuffer(sourceKey, vectorField);
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
    if (!prefix) {
      return { keys: [], cursor: '0' };
    }

    const vectorFieldNames = new Set(
      indexInfo.fields.filter(f => f.type === 'VECTOR').map(f => f.name),
    );

    const rawClient = client.getClient();
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const [nextCursor, scannedKeys] = await rawClient.scan(
      cursor, 'MATCH', `${prefix}*`, 'COUNT', cappedLimit,
    );
    const limitedKeys = (scannedKeys as string[]).slice(0, cappedLimit);

    if (limitedKeys.length === 0) {
      return { keys: [], cursor: String(nextCursor) };
    }

    const pipeline = rawClient.pipeline();
    for (const key of limitedKeys) {
      pipeline.hgetall(key);
    }
    const pipelineResults = await pipeline.exec();

    const keys = limitedKeys.map((key, i) => {
      const [err, rawFields] = pipelineResults![i];
      const fields: Record<string, string> = {};
      if (!err && rawFields && typeof rawFields === 'object') {
        for (const [fieldName, fieldValue] of Object.entries(rawFields as Record<string, string>)) {
          if (!vectorFieldNames.has(fieldName) && typeof fieldValue === 'string' && fieldValue.length < 2000) {
            fields[fieldName] = fieldValue;
          }
        }
      }
      return { key, fields };
    });

    return { keys, cursor: String(nextCursor) };
  }

  async browseIndex(
    connectionId: string | undefined,
    indexName: string,
    filter: string | undefined,
    limit: number,
  ): Promise<{ results: Array<{ key: string; fields: Record<string, string> }>; total: number }> {
    const client = this.getCheckedClient(connectionId);
    const indexInfo = await client.getVectorIndexInfo(indexName);
    const vectorFieldNames = new Set(
      indexInfo.fields.filter(f => f.type === 'VECTOR').map(f => f.name),
    );

    const rawClient = client.getClient();
    const cappedLimit = Math.min(Math.max(limit, 1), 50);
    const query = filter?.trim() || '*';

    const result = (await rawClient.call(
      'FT.SEARCH', indexName, query,
      'LIMIT', '0', String(cappedLimit),
      'DIALECT', '1',
    )) as unknown[];

    const results: Array<{ key: string; fields: Record<string, string> }> = [];
    for (let i = 1; i < result.length; i += 2) {
      const key = String(result[i]);
      const fieldsArr = result[i + 1] as unknown[];
      if (!Array.isArray(fieldsArr)) continue;
      const fields: Record<string, string> = {};
      for (let j = 0; j < fieldsArr.length; j += 2) {
        const fieldName = String(fieldsArr[j]);
        const fieldValue = fieldsArr[j + 1];
        if (!vectorFieldNames.has(fieldName) && fieldValue != null && String(fieldValue).length < 2000) {
          fields[fieldName] = String(fieldValue);
        }
      }
      results.push({ key, fields });
    }

    return { results, total: Number(result[0] ?? 0) };
  }
}
