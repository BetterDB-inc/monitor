import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBetterSqlite3 } from '../../storage/adapters/better-sqlite3-driver';
import type { RawDatabaseHandle } from '../../storage/raw-database-handle';
import { createBetterAuth, runBetterAuthMigrations } from '../better-auth.factory';
import { resolveWorkspaceConfig } from '../workspace-config';
import { BROKER_STATE_TTL_MS, BrokerStateRecord, BrokerStateStore } from './broker-state.store';

const RECORD: BrokerStateRecord = {
  origin: 'http://localhost',
  appOrigin: 'http://localhost',
  next: '/settings',
  inviteTokenHash: 'hash-1',
  nonceHash: 'nonce-hash-1',
};

function acceptAll(): boolean {
  return true;
}

function rejectAll(): boolean {
  return false;
}

interface Backend {
  handle: RawDatabaseHandle;
  dispose: () => void;
}

async function memoryBackend(): Promise<Backend> {
  return {
    handle: { kind: 'memory' },
    dispose: () => {
      return undefined;
    },
  };
}

async function sqliteBackend(): Promise<Backend> {
  const path = join(tmpdir(), `broker-state-${Date.now()}-${Math.random()}.db`);
  const Database = await loadBetterSqlite3();
  const db = new Database(path);
  return {
    handle: { kind: 'sqlite', db },
    dispose: () => {
      db.close();
      unlinkSync(path);
    },
  };
}

describe.each([
  ['memory', memoryBackend],
  ['sqlite', sqliteBackend],
])('BrokerStateStore (%s)', (_name, openBackend) => {
  let store: BrokerStateStore;
  let backend: Backend;

  beforeAll(async () => {
    backend = await openBackend();
    const auth = await createBetterAuth({
      handle: backend.handle,
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    await runBetterAuthMigrations(auth, backend.handle);
    store = new BrokerStateStore(auth);
  });

  afterAll(() => {
    backend.dispose();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues a 43-character base64url state', async () => {
    const state = await store.create(RECORD);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('consumes an accepted record once and reports it missing on the second consume', async () => {
    const state = await store.create(RECORD);
    expect(await store.consume(state, acceptAll)).toEqual({ status: 'consumed', record: RECORD });
    expect(await store.consume(state, acceptAll)).toEqual({ status: 'missing' });
  });

  it('hands the stored record to the binding check', async () => {
    const state = await store.create(RECORD);
    const accept = jest.fn(acceptAll);
    await store.consume(state, accept);
    expect(accept).toHaveBeenCalledWith(RECORD);
  });

  it('leaves a rejected record in place for a later accepted consume', async () => {
    const state = await store.create(RECORD);
    expect(await store.consume(state, rejectAll)).toEqual({ status: 'rejected', record: RECORD });
    expect(await store.consume(state, rejectAll)).toEqual({ status: 'rejected', record: RECORD });
    expect(await store.consume(state, acceptAll)).toEqual({ status: 'consumed', record: RECORD });
    expect(await store.consume(state, acceptAll)).toEqual({ status: 'missing' });
  });

  it('reports an unknown state missing without asking the binding check', async () => {
    const accept = jest.fn(acceptAll);
    expect(await store.consume('unknown-state', accept)).toEqual({ status: 'missing' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('keeps a null invite hash as null', async () => {
    const state = await store.create({ ...RECORD, inviteTokenHash: null });
    expect(await store.consume(state, acceptAll)).toEqual({
      status: 'consumed',
      record: { ...RECORD, inviteTokenHash: null },
    });
  });

  it('reports a state past its ttl missing', async () => {
    const now = Date.now();
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const state = await store.create(RECORD);
    jest.setSystemTime(now + BROKER_STATE_TTL_MS + 1000);
    expect(await store.consume(state, acceptAll)).toEqual({ status: 'missing' });
  });

  it('hands the record to exactly one of two concurrent accepted consumers', async () => {
    const state = await store.create(RECORD);
    const results = await Promise.all([
      store.consume(state, acceptAll),
      store.consume(state, acceptAll),
    ]);
    const winners = results.filter((result) => {
      return result.status === 'consumed';
    });
    expect(winners).toEqual([{ status: 'consumed', record: RECORD }]);
    expect(results).toContainEqual({ status: 'missing' });
  });
});
