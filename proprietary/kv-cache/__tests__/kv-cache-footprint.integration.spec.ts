import Valkey from 'iovalkey';
import { Feature } from '@betterdb/shared';
import { UnifiedDatabaseAdapter } from '@app/database/adapters/unified.adapter';
import { KvCacheFootprintService } from '../kv-cache-footprint.service';

const HOST = process.env.VALKEY_HOST || 'localhost';
const PORT = parseInt(process.env.VALKEY_PORT || '6380', 10);
const PASSWORD = process.env.VALKEY_PASSWORD || 'devpassword';
const TEST_DB = 9;
const CONNECTION_ID = 'kv-cache-integration';

async function probe(): Promise<boolean> {
  const client = new Valkey({ host: HOST, port: PORT, password: PASSWORD, lazyConnect: true, maxRetriesPerRequest: 0 });
  const ok = await client.connect().then(() => true, () => false);
  client.disconnect();
  return ok;
}

const chunk = (model: string, i: number, suffix: string) => `${model}@1@0@${(i + 1).toString(16)}@${suffix}`;

describe('KvCacheFootprintService against a real Valkey', () => {
  let reachable = false;
  let adapter: UnifiedDatabaseAdapter;
  let service: KvCacheFootprintService;
  let saved: unknown[] = [];

  beforeAll(async () => {
    reachable = await probe();
    if (!reachable) return;
    adapter = new UnifiedDatabaseAdapter({ host: HOST, port: PORT, username: 'default', password: PASSWORD, connectionId: CONNECTION_ID });
    await adapter.connect();
    const client = adapter.getClient();
    await client.select(TEST_DB);
    await client.flushdb();

    const kv = Buffer.alloc(4096, 1);
    const meta = Buffer.alloc(128, 2);
    const pipeline = client.pipeline();
    for (let i = 0; i < 6; i++) pipeline.set(chunk('m/x', i, 'bfloat16'), kv);
    for (let i = 0; i < 3; i++) {
      pipeline.set(chunk('m/y', i, 'float16kv_bytes'), kv);
      if (i < 2) pipeline.set(chunk('m/y', i, 'float16metadata'), meta);
    }
    pipeline.set(chunk('m/x', 100, 'bfloat16'), kv, 'EX', 3600);
    for (const key of ['user:1', 'a@b', 'x@y@z@w@v']) pipeline.set(key, 'v');
    for (let i = 0; i < 17; i++) pipeline.set(`user:other:${i}`, 'v');
    await pipeline.exec();

    const registry = {
      list: () => [{ id: CONNECTION_ID, name: 'integration', isConnected: true, connectionType: 'direct' }],
      get: () => adapter,
      getConfig: () => ({ id: CONNECTION_ID, name: 'integration', host: HOST, port: PORT, dbIndex: TEST_DB }),
    } as any;
    const storage = {
      saveKvCacheFootprintSnapshot: async (snapshot: unknown) => {
        saved.push(snapshot);
      },
      deleteKvCacheConnectionData: async () => undefined,
    } as any;
    const license = { hasFeature: (f: string) => f === Feature.KV_CACHE_MONITORING } as any;
    service = new KvCacheFootprintService(registry, storage, license);
  });

  afterAll(async () => {
    if (!reachable || !adapter) return;
    await adapter.getClient().flushdb();
    await adapter.disconnect();
  });

  it('measures the seeded LMCache keys', async () => {
    if (!reachable) return;
    const snapshot = await service.triggerCollection(CONNECTION_ID);
    expect(snapshot).toMatchObject({
      connectionId: CONNECTION_ID,
      detected: true,
      layout: 'mixed',
      matchedKeys: 12,
      scanComplete: true,
      chunksEst: 10,
      orphanRatio: 0.3333,
      noTtlRatio: 0.9167,
    });
    expect(snapshot?.perModel.map((m) => m.model)).toEqual(expect.arrayContaining(['m/x', 'm/y']));
    expect(saved).toHaveLength(1);
  });
});
