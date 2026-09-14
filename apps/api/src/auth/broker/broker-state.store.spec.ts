import { createBetterAuth } from '../better-auth.factory';
import { resolveWorkspaceConfig } from '../workspace-config';
import { BROKER_STATE_TTL_MS, BrokerStateRecord, BrokerStateStore } from './broker-state.store';

const RECORD: BrokerStateRecord = {
  origin: 'http://localhost',
  appOrigin: 'http://localhost',
  next: '/settings',
  inviteTokenHash: 'hash-1',
};

describe('BrokerStateStore', () => {
  let store: BrokerStateStore;

  beforeAll(async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    store = new BrokerStateStore(auth);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues a 43-character base64url state', async () => {
    const state = await store.create(RECORD);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns the record once and null on the second consume', async () => {
    const state = await store.create(RECORD);
    expect(await store.consume(state)).toEqual(RECORD);
    expect(await store.consume(state)).toBeNull();
  });

  it('returns null for an unknown state', async () => {
    expect(await store.consume('unknown-state')).toBeNull();
  });

  it('keeps a null invite hash as null', async () => {
    const state = await store.create({ ...RECORD, inviteTokenHash: null });
    expect(await store.consume(state)).toEqual({ ...RECORD, inviteTokenHash: null });
  });

  it('returns null for a state past its ttl', async () => {
    const now = Date.now();
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const state = await store.create(RECORD);
    jest.setSystemTime(now + BROKER_STATE_TTL_MS + 1000);
    expect(await store.consume(state)).toBeNull();
  });

  it('hands the record to exactly one of two concurrent consumers', async () => {
    const state = await store.create(RECORD);
    const results = await Promise.all([store.consume(state), store.consume(state)]);
    const winners = results.filter((result) => {
      return result !== null;
    });
    expect(winners).toEqual([RECORD]);
  });
});
