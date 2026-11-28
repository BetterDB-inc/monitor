import { Informer, KubeClient, KubeObject } from '../kube-client';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const item = (name: string, rv = '1'): KubeObject => ({ metadata: { name, namespace: 'db', resourceVersion: rv } });

describe('Informer', () => {
  it('delivers nothing from a LIST that resolves after stop()', async () => {
    const list = deferred<{ metadata: { resourceVersion: string }; items: KubeObject[] }>();
    const seenSignals: AbortSignal[] = [];
    const client = {
      get: jest.fn((_path: string, signal?: AbortSignal) => {
        if (signal) seenSignals.push(signal);
        return list.promise;
      }),
      watch: jest.fn(),
    };
    const changes: string[] = [];
    const informer = new Informer<KubeObject>({ client: client as unknown as KubeClient, path: '/api/v1/namespaces/db/secrets', onChange: (key) => changes.push(key) });

    informer.start();
    const stopping = informer.stop();
    list.resolve({ metadata: { resourceVersion: '1' }, items: [item('a')] });
    await stopping;

    expect(changes).toEqual([]);
    expect(informer.items()).toEqual([]);
    expect(client.watch).not.toHaveBeenCalled();
    expect(seenSignals[0]?.aborted).toBe(true);
  });

  it('lists, watches and diffs: changed objects once, deletions as null, relists against the cache', async () => {
    let onEvent: ((e: { type: string; object: KubeObject }) => void) | null = null;
    const watchClosed = deferred<void>();
    const lists = [
      { metadata: { resourceVersion: '1' }, items: [item('a'), item('b')] },
      { metadata: { resourceVersion: '5' }, items: [item('a', '3')] },
    ];
    // Only the first watch stream ends on its own (as a server-side timeout
    // would); later ones stay open until stop(), or the loop would relist
    // without pause.
    let watches = 0;
    const client = {
      get: jest.fn(async () => lists.shift() ?? { metadata: { resourceVersion: '9' }, items: [item('a', '3')] }),
      watch: jest.fn((_p: string, _rv: string, handler: typeof onEvent, signal: AbortSignal) => {
        onEvent = handler;
        const first = watches++ === 0;
        return new Promise<void>((resolve) => {
          if (first) watchClosed.promise.then(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }),
    };
    const changes: Array<[string, string | null]> = [];
    const informer = new Informer<KubeObject>({
      client: client as unknown as KubeClient,
      path: '/x',
      onChange: (key, obj) => changes.push([key, obj?.metadata.resourceVersion ?? null]),
      maxBackoffMs: 1,
    });

    informer.start();
    await new Promise((r) => setImmediate(r));
    expect(changes).toEqual([['db/a', '1'], ['db/b', '1']]);

    onEvent!({ type: 'MODIFIED', object: item('a', '2') });
    onEvent!({ type: 'MODIFIED', object: item('a', '2') });
    onEvent!({ type: 'DELETED', object: item('b') });
    expect(changes.slice(2)).toEqual([['db/a', '2'], ['db/b', null]]);

    // The stream ends; the relist sees a newer "a" and nothing else.
    watchClosed.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(changes.slice(4)).toEqual([['db/a', '3']]);

    await informer.stop();
  });
});
