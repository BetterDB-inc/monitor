import { Feature } from '@betterdb/shared';
import { UnifiedDatabaseAdapter } from '@app/database/adapters/unified.adapter';
import { KvCacheFootprintService } from '../kv-cache-footprint.service';

const PORT_SETTING = process.env.KV_CACHE_IT_VALKEY_PORT?.trim();
const HOST = process.env.KV_CACHE_IT_VALKEY_HOST || 'localhost';
const PORT = Number(PORT_SETTING);
const PASSWORD = process.env.KV_CACHE_IT_VALKEY_PASSWORD ?? 'devpassword';
const TEST_DB = 9;
const CONNECTION_ID = 'kv-cache-integration';
const configured = Boolean(PORT_SETTING);
const suite = configured ? describe : describe.skip;
const title = configured
  ? `KvCacheFootprintService against a real Valkey on ${HOST}:${PORT_SETTING}`
  : 'KvCacheFootprintService against a real Valkey (skipped: set KV_CACHE_IT_VALKEY_PORT to a disposable Valkey)';

const chunk = (model: string, i: number, suffix: string) => `${model}@1@0@${(i + 1).toString(16)}@${suffix}`;

suite(title, () => {
  let selected = false;
  let adapter: UnifiedDatabaseAdapter | undefined;
  let service: KvCacheFootprintService;
  let saved: unknown[] = [];

  beforeAll(async () => {
    expect(Number.isInteger(PORT) && PORT > 0).toBe(true);
    const target = new UnifiedDatabaseAdapter({
      host: HOST,
      port: PORT,
      username: 'default',
      password: PASSWORD,
      connectionId: CONNECTION_ID,
      dbIndex: TEST_DB,
    });
    adapter = target;
    await target.connect();
    expect(target.getActiveDbIndex()).toBe(TEST_DB);
    selected = true;
    const client = target.getClient();
    await client.flushdb();

    const kv = Buffer.alloc(4096, 1);
    const meta = Buffer.alloc(128, 2);
    const pipeline = client.pipeline();
    for (let i = 0; i < 6; i++) pipeline.set(chunk('m/x', i, 'bfloat16'), kv);
    for (let i = 0; i < 3; i++) {
      pipeline.set(chunk('m/y', i, 'halfkv_bytes'), kv);
      if (i < 2) pipeline.set(chunk('m/y', i, 'halfmetadata'), meta);
    }
    pipeline.set(chunk('m/x', 100, 'bfloat16'), kv, 'EX', 3600);
    for (const key of ['user:1', 'a@b', 'x@y@z@w@v']) pipeline.set(key, 'v');
    for (let i = 0; i < 17; i++) pipeline.set(`user:other:${i}`, 'v');
    await pipeline.exec();

    const registry = {
      list: () => [{ id: CONNECTION_ID, name: 'integration', isConnected: true, connectionType: 'direct' }],
      get: () => target,
      getConfig: () => ({ id: CONNECTION_ID, name: 'integration', host: HOST, port: PORT, dbIndex: TEST_DB }),
    } as any;
    const storage = {
      saveKvCacheFootprintSnapshot: async (snapshot: unknown) => {
        saved.push(snapshot);
      },
      getKvCacheFootprintSnapshots: async () => [],
      deleteKvCacheConnectionData: async () => undefined,
    } as any;
    const license = { hasFeature: (f: string) => f === Feature.KV_CACHE_MONITORING } as any;
    service = new KvCacheFootprintService(registry, storage, license);
  });

  afterAll(async () => {
    if (selected) await adapter?.getClient().flushdb();
    await adapter?.disconnect();
  });

  it('measures the seeded LMCache keys', async () => {
    const snapshot = await service.triggerCollection(CONNECTION_ID);
    expect(snapshot).toMatchObject({
      connectionId: CONNECTION_ID,
      detected: true,
      layout: 'mixed',
      matchedKeys: 12,
      scanComplete: true,
      chunksEst: 10,
      orphanRatio: 0.2,
      noTtlRatio: 0.9167,
    });
    expect(snapshot?.perModel.map((m) => m.model)).toEqual(expect.arrayContaining(['m/x', 'm/y']));
    expect(snapshot?.otherDbs).not.toContain(TEST_DB);
    expect(saved).toHaveLength(1);
  });
});
