/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { Test, TestingModule } from '@nestjs/testing';
import { VectorSearchService } from '../vector-search.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { RetentionPolicyService } from '../../retention/retention-policy.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ConnectionContext } from '../../common/services/multi-connection-poller';
import { PrometheusService } from '../../prometheus/prometheus.service';
import { VectorIndexInfo } from '../../common/types/metrics.types';

function makeInfo(name: string, overrides: Partial<VectorIndexInfo> = {}): VectorIndexInfo {
  return {
    name,
    numDocs: 100,
    numRecords: 200,
    numDeletedDocs: 0,
    numVectorFields: 1,
    indexingState: 'indexed',
    percentIndexed: 100,
    memorySizeMb: 10,
    indexingFailures: 0,
    totalIndexingTime: 0,
    fields: [],
    gcStats: null,
    indexDefinition: null,
    ...overrides,
  };
}

describe('VectorSearchService.pollConnection — extended snapshot fields', () => {
  let service: VectorSearchService;
  let storage: jest.Mocked<StoragePort>;
  let prometheus: jest.Mocked<PrometheusService>;

  function buildClient(info: VectorIndexInfo) {
    return {
      getCapabilities: () => ({ hasVectorSearch: true }),
      getVectorIndexList: jest.fn().mockResolvedValue([info.name]),
      getVectorIndexInfo: jest.fn().mockResolvedValue(info),
    };
  }

  function makeCtx(client: any, connectionId = 'conn-x'): ConnectionContext {
    return {
      connectionId,
      connectionName: 'test',
      client,
      host: 'h',
      port: 6379,
    };
  }

  beforeEach(async () => {
    storage = {
      saveVectorIndexSnapshots: jest.fn().mockResolvedValue(1),
      getVectorIndexSnapshots: jest.fn().mockResolvedValue([]),
      pruneOldVectorIndexSnapshots: jest.fn().mockResolvedValue(0),
    } as any;

    prometheus = {
      updateVectorIndexMetrics: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorSearchService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: PrometheusService, useValue: prometheus },
        {
          provide: ConnectionRegistry,
          useValue: { getDefaultId: jest.fn(), list: jest.fn().mockReturnValue([]) },
        },
        {
          provide: RetentionPolicyService,
          useValue: { getSampleRetentionMs: () => 7 * 24 * 60 * 60 * 1000 },
        },
      ],
    }).compile();

    service = module.get<VectorSearchService>(VectorSearchService);
  });

  it('persists all extended VectorIndexInfo fields in the snapshot', async () => {
    const info = makeInfo('idx_a', {
      numDocs: 1000,
      numRecords: 2000,
      numDeletedDocs: 12,
      indexingFailures: 5,
      percentIndexed: 92,
      indexingState: 'indexing',
      totalIndexingTime: 7500,
      memorySizeMb: 22.5,
    });
    const client = buildClient(info);

    await (service as any).pollConnection(makeCtx(client));

    expect(storage.saveVectorIndexSnapshots).toHaveBeenCalledTimes(1);
    const [[batch]] = storage.saveVectorIndexSnapshots.mock.calls;
    const [snap] = batch;

    expect(snap.indexName).toBe('idx_a');
    expect(snap.numDocs).toBe(1000);
    expect(snap.numRecords).toBe(2000);
    expect(snap.numDeletedDocs).toBe(12);
    expect(snap.indexingFailures).toBe(5);
    expect(snap.percentIndexed).toBe(92);
    expect(snap.indexingState).toBe('indexing');
    expect(snap.totalIndexingTime).toBe(7500);
    expect(snap.memorySizeMb).toBe(22.5);
  });

  it('reports indexingFailuresDelta as 0 on the first poll', async () => {
    const info = makeInfo('idx_a', { indexingFailures: 7 });
    const client = buildClient(info);

    await (service as any).pollConnection(makeCtx(client));

    const [[batch]] = storage.saveVectorIndexSnapshots.mock.calls;
    expect(batch[0].indexingFailuresDelta).toBe(0);
  });

  it('reports indexingFailuresDelta as the difference between consecutive polls', async () => {
    const info1 = makeInfo('idx_a', { indexingFailures: 3 });
    const client = buildClient(info1);
    await (service as any).pollConnection(makeCtx(client));

    const info2 = makeInfo('idx_a', { indexingFailures: 10 });
    client.getVectorIndexInfo.mockResolvedValueOnce(info2);
    await (service as any).pollConnection(makeCtx(client));

    const lastCall = storage.saveVectorIndexSnapshots.mock.calls.at(-1)!;
    const [lastBatch] = lastCall;
    expect(lastBatch[0].indexingFailures).toBe(10);
    expect(lastBatch[0].indexingFailuresDelta).toBe(7);
  });

  it('clamps negative delta (e.g. after FT.DROPINDEX + recreate) to 0', async () => {
    const info1 = makeInfo('idx_a', { indexingFailures: 5 });
    const client = buildClient(info1);
    await (service as any).pollConnection(makeCtx(client));

    const info2 = makeInfo('idx_a', { indexingFailures: 1 });
    client.getVectorIndexInfo.mockResolvedValueOnce(info2);
    await (service as any).pollConnection(makeCtx(client));

    const lastCall = storage.saveVectorIndexSnapshots.mock.calls.at(-1)!;
    const [lastBatch] = lastCall;
    expect(lastBatch[0].indexingFailuresDelta).toBe(0);
  });

  it('tracks delta per (connectionId, indexName) independently', async () => {
    const info = makeInfo('idx_a', { indexingFailures: 3 });
    const client = buildClient(info);

    await (service as any).pollConnection(makeCtx(client, 'conn-1'));
    await (service as any).pollConnection(makeCtx(client, 'conn-2'));

    // conn-2's first poll should still report delta 0 even though conn-1 saw the same value first
    const secondCall = storage.saveVectorIndexSnapshots.mock.calls[1];
    expect(secondCall[0][0].indexingFailuresDelta).toBe(0);
  });

  it('exports gauge values via PrometheusService after each poll', async () => {
    const info = makeInfo('idx_a', {
      numDocs: 500,
      memorySizeMb: 8,
      indexingFailures: 2,
      percentIndexed: 80,
    });
    const client = buildClient(info);

    await (service as any).pollConnection(makeCtx(client, 'conn-1'));

    expect(prometheus.updateVectorIndexMetrics).toHaveBeenCalledWith('conn-1', [
      {
        indexName: 'idx_a',
        numDocs: 500,
        memorySizeMb: 8,
        indexingFailures: 2,
        percentIndexed: 80,
      },
    ]);
  });

  it('skips polling entirely when hasVectorSearch is false', async () => {
    const client = {
      getCapabilities: () => ({ hasVectorSearch: false }),
      getVectorIndexList: jest.fn(),
      getVectorIndexInfo: jest.fn(),
    };

    await (service as any).pollConnection(makeCtx(client));

    expect(client.getVectorIndexList).not.toHaveBeenCalled();
    expect(storage.saveVectorIndexSnapshots).not.toHaveBeenCalled();
  });

  it('clears stale Prometheus labels when the index list becomes empty', async () => {
    const client = {
      getCapabilities: () => ({ hasVectorSearch: true }),
      getVectorIndexList: jest.fn().mockResolvedValue([]),
      getVectorIndexInfo: jest.fn(),
    };

    await (service as any).pollConnection(makeCtx(client, 'conn-empty'));

    expect(prometheus.updateVectorIndexMetrics).toHaveBeenCalledWith('conn-empty', []);
    expect(storage.saveVectorIndexSnapshots).not.toHaveBeenCalled();
  });

  it('clears stale Prometheus labels when every getVectorIndexInfo call fails', async () => {
    const client = {
      getCapabilities: () => ({ hasVectorSearch: true }),
      getVectorIndexList: jest.fn().mockResolvedValue(['idx_a', 'idx_b']),
      getVectorIndexInfo: jest.fn().mockRejectedValue(new Error('index dropped')),
    };

    await (service as any).pollConnection(makeCtx(client, 'conn-flaky'));

    expect(prometheus.updateVectorIndexMetrics).toHaveBeenCalledWith('conn-flaky', []);
    expect(storage.saveVectorIndexSnapshots).not.toHaveBeenCalled();
  });
});

describe('VectorSearchService.sampleKeys: SCAN MATCH glob escaping', () => {
  function buildRawClient(prefixes: string[], keysByPattern: Record<string, string[]>) {
    const scanPatterns: Array<string | undefined> = [];
    const client = {
      getCapabilities: () => ({ hasVectorSearch: true }),
      getVectorIndexInfo: jest.fn().mockResolvedValue(
        makeInfo('idx_keys', {
          indexDefinition: { prefixes, defaultLanguage: null, defaultScore: null },
        }),
      ),
      getClient: () => ({
        scan: jest.fn(async (cursor: string, ...args: unknown[]) => {
          const matchIndex = args.indexOf('MATCH');
          const pattern = matchIndex === -1 ? undefined : (args[matchIndex + 1] as string);
          scanPatterns.push(pattern);
          return ['0', pattern ? (keysByPattern[pattern] ?? []) : []];
        }),
        pipeline: () => {
          const visited: string[] = [];
          return {
            hgetall: (key: string) => {
              visited.push(key);
            },
            exec: async () => visited.map((key) => [null, { content: `value for ${key}` }]),
          };
        },
      }),
    };
    return { client, scanPatterns };
  }

  function buildService(client: any) {
    const registry = {
      get: () => client,
      getDefaultId: jest.fn().mockReturnValue('conn-keys'),
      list: jest.fn().mockReturnValue([]),
    } as any;
    const storage = {
      saveVectorIndexSnapshots: jest.fn().mockResolvedValue(1),
      getVectorIndexSnapshots: jest.fn().mockResolvedValue([]),
      pruneOldVectorIndexSnapshots: jest.fn().mockResolvedValue(0),
    } as any;
    const prometheus = { updateVectorIndexMetrics: jest.fn() } as any;
    const retention = { getSampleRetentionMs: () => 7 * 24 * 60 * 60 * 1000 } as any;
    return new VectorSearchService(registry, storage, prometheus, retention);
  }

  it('escapes brackets so only the index own keys are sampled', async () => {
    const { client, scanPatterns } = buildRawClient(['tenant[1]:doc:'], {
      'tenant\\[1\\]:doc:*': ['tenant[1]:doc:42'],
      'tenant[1]:doc:*': ['tenant1:doc:other'],
    });

    const { keys } = await buildService(client).sampleKeys('conn-keys', 'idx_keys', '0', 10);

    expect(scanPatterns).toEqual(['tenant\\[1\\]:doc:*']);
    expect(keys.map((k) => k.key)).toEqual(['tenant[1]:doc:42']);
  });

  it('escapes ? so a single character wildcard cannot leak keys of other indexes', async () => {
    const { client, scanPatterns } = buildRawClient(['cache?:'], {
      'cache\\?:*': ['cacheA:1'],
    });

    const { keys } = await buildService(client).sampleKeys('conn-keys', 'idx_keys', '0', 10);

    expect(scanPatterns).toEqual(['cache\\?:*']);
    expect(keys.map((k) => k.key)).toEqual(['cacheA:1']);
  });

  it('escapes the prefix of every index when an index has several prefixes', async () => {
    const { client, scanPatterns } = buildRawClient(['a[1]:', 'b?:'], {
      'a\\[1\\]:*': ['a[1]:1'],
      'b\\?:*': ['b:z:2'],
    });

    const { keys, cursor } = await buildService(client).sampleKeys(
      'conn-keys',
      'idx_keys',
      '0',
      10,
    );

    expect(scanPatterns).toEqual(['a\\[1\\]:*', 'b\\?:*']);
    expect(keys.map((k) => k.key)).toEqual(['a[1]:1', 'b:z:2']);
    expect(cursor).toBe('0');
  });

  it('leaves a prefix without glob characters untouched', async () => {
    const { client, scanPatterns } = buildRawClient(['doc:'], {
      'doc:*': ['doc:1'],
    });

    const { keys } = await buildService(client).sampleKeys('conn-keys', 'idx_keys', '0', 10);

    expect(scanPatterns).toEqual(['doc:*']);
    expect(keys.map((k) => k.key)).toEqual(['doc:1']);
  });
});
