import type { CustomSchema, SessionNamespace } from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

const schema: CustomSchema = {
  valueType: 'list',
  messages: { from: 'items' },
  fields: { role: 'type', content: 'data.content' },
};

export const ns = (o: Partial<SessionNamespace> = {}): SessionNamespace => ({
  id: 'ns-1',
  connectionId: 'conn-a',
  name: 'Chat history',
  pattern: 'message_store:*',
  preset: 'langchain-community',
  customSchema: null,
  oversizeThresholdBytes: 1048576,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...o,
});

export function runNamespaceStorageContract(getStorage: () => StoragePort): void {
  let storage: StoragePort;
  beforeEach(() => {
    storage = getStorage();
  });

  it('round-trips a namespace including the custom schema', async () => {
    const input = ns({ preset: 'custom', customSchema: schema, oversizeThresholdBytes: 5_000_000_000 });
    const saved = await storage.saveSessionNamespace(input);
    expect(saved.id).toBe('ns-1');
    expect(await storage.getSessionNamespace('conn-a', 'ns-1')).toEqual(input);
  });

  it('lists only the namespaces of the given connection in creation order', async () => {
    await storage.saveSessionNamespace(ns({ id: 'b', createdAt: 2_000 }));
    await storage.saveSessionNamespace(ns({ id: 'a', createdAt: 1_000 }));
    await storage.saveSessionNamespace(ns({ id: 'c', connectionId: 'conn-b' }));
    expect((await storage.listSessionNamespaces('conn-a')).map((n) => n.id)).toEqual(['a', 'b']);
    expect((await storage.listSessionNamespaces('conn-b')).map((n) => n.id)).toEqual(['c']);
  });

  it('does not expose a namespace through another connection', async () => {
    await storage.saveSessionNamespace(ns());
    expect(await storage.getSessionNamespace('conn-b', 'ns-1')).toBeNull();
    expect(await storage.deleteSessionNamespace('conn-b', 'ns-1')).toBe(false);
    expect(await storage.getSessionNamespace('conn-a', 'ns-1')).not.toBeNull();
  });

  it('upserts by id and keeps createdAt', async () => {
    await storage.saveSessionNamespace(ns());
    await storage.saveSessionNamespace(
      ns({ name: 'Renamed', pattern: 'app:*', createdAt: 9_999, updatedAt: 2_000 }),
    );
    const all = await storage.listSessionNamespaces('conn-a');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      name: 'Renamed',
      pattern: 'app:*',
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  it('deletes an existing namespace and returns false for an unknown id', async () => {
    await storage.saveSessionNamespace(ns());
    expect(await storage.deleteSessionNamespace('conn-a', 'ns-1')).toBe(true);
    expect(await storage.getSessionNamespace('conn-a', 'ns-1')).toBeNull();
    expect(await storage.deleteSessionNamespace('conn-a', 'missing')).toBe(false);
  });

  it('rejects saving an id owned by another connection and leaves it unchanged', async () => {
    await storage.saveSessionNamespace(ns());
    await expect(
      storage.saveSessionNamespace(ns({ connectionId: 'conn-b', name: 'Hijacked', updatedAt: 5_000 })),
    ).rejects.toThrow();
    expect(await storage.getSessionNamespace('conn-a', 'ns-1')).toEqual(ns());
    expect(await storage.listSessionNamespaces('conn-b')).toEqual([]);
  });
}
