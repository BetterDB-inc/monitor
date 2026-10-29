import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CapturedKey, SessionNamespace } from '@betterdb/shared';
import Valkey from 'iovalkey';
import { SessionExplorerService } from '../session-explorer.service';
import { keysForSessionOn, scanSessions } from '../session-scanner';
import { readSessionKeysOn, type SessionKeysRead } from '../session-reader';
import { type PrimaryClients, type PrimaryRoute, withPrimaries } from '../primary-nodes';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../session-scanner', () => ({
  ...jest.requireActual('../session-scanner'),
  keysForSessionOn: jest.fn(),
  scanSessions: jest.fn(),
}));
jest.mock('../primary-nodes', () => {
  const actual = jest.requireActual('../primary-nodes');
  return { ...actual, withPrimaries: jest.fn(actual.withPrimaries) };
});
jest.mock('../session-reader', () => ({
  ...jest.requireActual('../session-reader'),
  readSessionKeysOn: jest.fn(),
}));

const keysFor = keysForSessionOn as jest.MockedFunction<typeof keysForSessionOn>;
const read = readSessionKeysOn as jest.MockedFunction<typeof readSessionKeysOn>;
const actualWithPrimaries = jest.requireActual('../primary-nodes').withPrimaries;
const stubPrimaries: PrimaryClients = {
  routes: [],
  touchesKeys: false,
  release: async () => undefined,
};
const route = (): PrimaryRoute => ({ slots: [], client: null });
const failedRoutes = (count: number) => new Set(Array.from({ length: count }, route));
const ValkeyMock = Valkey as unknown as jest.Mock;

const ns: SessionNamespace = {
  id: 'ns-1',
  connectionId: 'conn-1',
  name: 'LangChain',
  pattern: 'lc:*',
  preset: 'langchain-community',
  customSchema: null,
  oversizeThresholdBytes: 1048576,
  createdAt: 1,
  updatedAt: 1,
};

const message = JSON.stringify({ type: 'human', data: { content: 'abcdefgh' } });

const captured = (overrides: Partial<CapturedKey> = {}): CapturedKey => ({
  key: 'lc:1',
  type: 'list',
  pttl: 5000,
  value: [message],
  bytes: 64,
  ...overrides,
});

const readOf = (overrides: Partial<SessionKeysRead> = {}): SessionKeysRead => ({
  keys: [captured()],
  truncated: false,
  failed: failedRoutes(0),
  missingKeys: 0,
  erroredKeys: 0,
  touchesKeys: false,
  totals: { memoryBytes: 64, unmeasuredKeys: 0, goneKeys: 0, ttlMs: 5000 },
  ...overrides,
});

afterEach(() => jest.mocked(withPrimaries).mockImplementation(actualWithPrimaries));

describe('SessionExplorerService.getSession', () => {
  const storage = { getSessionNamespace: jest.fn(async () => ns) };
  const registry = { get: jest.fn(() => ({})) };
  const service = new SessionExplorerService(registry as never, storage as never);

  beforeEach(() => {
    jest.mocked(withPrimaries).mockImplementation(async (_db, fn) => fn(stubPrimaries));
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: false, failed: failedRoutes(0) });
    read.mockResolvedValue(readOf());
  });

  it('summarises a clean session as complete with a token estimate', async () => {
    const detail = await service.getSession('conn-1', 'ns-1', 'lc:1');
    expect(detail).toMatchObject({
      sessionId: 'lc:1',
      preset: 'langchain-community',
      complete: true,
      unparsedKeys: 0,
      truncated: false,
      failedNodes: 0,
      missingKeys: 0,
      estimatedTokens: 2,
      ttlMs: 5000,
      memoryBytes: 64,
    });
  });

  it('says when reading the session reset its access time', async () => {
    read.mockResolvedValueOnce(readOf({ touchesKeys: true }));
    const detail = await service.getSession('conn-1', 'ns-1', 'lc:1');
    expect(detail.touchesKeys).toBe(true);
  });

  const agentCacheKeys = (p: string) => [
    `${p}:checkpoint:1f0-a`,
    `${p}:checkpoint:1f0-b`,
    `${p}:__checkpoint_latest`,
    `${p}:writes:1f0-a|task-1|messages|0`,
    `${p}:writes:1f0-b|task-2|messages|0`,
  ];

  it('measures every session key but reads only the keys the preset selects', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce({ ...ns, preset: 'agent-cache' });
    const p = 'ac:session:t1';
    keysFor.mockResolvedValue({ keys: agentCacheKeys(p), truncated: false, failed: failedRoutes(0) });
    await service.getSession('conn-1', 'ns-1', 't1');
    expect(read).toHaveBeenLastCalledWith(expect.anything(), agentCacheKeys(p), {
      selected: [`${p}:__checkpoint_latest`, `${p}:writes:1f0-b|task-2|messages|0`],
    });
  });

  it('totals the whole session when it reads only the selected keys', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce({ ...ns, preset: 'agent-cache' });
    keysFor.mockResolvedValue({ keys: agentCacheKeys('ac:session:t1'), truncated: false, failed: failedRoutes(0) });
    read.mockResolvedValueOnce(
      readOf({ totals: { memoryBytes: 364, unmeasuredKeys: 2, goneKeys: 0, ttlMs: 1200 } }),
    );
    const detail = await service.getSession('conn-1', 'ns-1', 't1');
    expect(detail).toMatchObject({
      memoryBytes: 64,
      totalKeys: 5,
      skippedKeys: 3,
      totalMemoryBytes: 364,
      unmeasuredKeys: 2,
      ttlMs: 1200,
      selection: 'latest checkpoint and its pending writes',
    });
  });

  it('leaves skipped keys that expired before the read out of the totals', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce({ ...ns, preset: 'agent-cache' });
    keysFor.mockResolvedValue({ keys: agentCacheKeys('ac:session:t1'), truncated: false, failed: failedRoutes(0) });
    read.mockResolvedValueOnce(
      readOf({ totals: { memoryBytes: 300, unmeasuredKeys: 0, goneKeys: 2, ttlMs: 1200 } }),
    );
    const detail = await service.getSession('conn-1', 'ns-1', 't1');
    expect(detail).toMatchObject({
      totalKeys: 3,
      skippedKeys: 1,
      totalMemoryBytes: 300,
      unmeasuredKeys: 0,
    });
  });

  it('reports keys whose read failed apart from keys that vanished', async () => {
    read.mockResolvedValue(readOf({ erroredKeys: 1 }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      missingKeys: 0,
      erroredKeys: 1,
    });
  });

  it('totals equal the read keys when the preset reads every key', async () => {
    const detail = await service.getSession('conn-1', 'ns-1', 'lc:1');
    expect(read).toHaveBeenLastCalledWith(expect.anything(), ['lc:1'], { selected: ['lc:1'] });
    expect(detail).toMatchObject({
      totalKeys: 1,
      skippedKeys: 0,
      totalMemoryBytes: 64,
      unmeasuredKeys: 0,
      selection: null,
    });
  });

  it('keeps pending interrupts out of the messages and the token estimate', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce({ ...ns, preset: 'agent-cache' });
    const p = 'ac:session:t1';
    const latest = `${p}:__checkpoint_latest`;
    const interrupt = `${p}:writes:1f0-b|task-2|__interrupt__|0`;
    keysFor.mockResolvedValue({ keys: [latest, interrupt], truncated: false, failed: failedRoutes(0) });
    const str = (key: string, value: unknown): CapturedKey =>
      captured({ key, type: 'string', value: JSON.stringify(value) });
    read.mockResolvedValueOnce(
      readOf({
        keys: [
          str(latest, { checkpoint: { channel_values: { messages: [] } } }),
          str(interrupt, [{ value: 'a question long enough to count as tokens' }]),
        ],
      }),
    );
    const detail = await service.getSession('conn-1', 'ns-1', 't1');
    expect(detail.messages).toEqual([]);
    expect(detail.estimatedTokens).toBe(0);
    expect(detail.interrupts).toEqual([{ value: 'a question long enough to count as tokens' }]);
  });

  it('lists no interrupts for a preset without them', async () => {
    expect((await service.getSession('conn-1', 'ns-1', 'lc:1')).interrupts).toEqual([]);
  });

  it('is incomplete when the key scan was capped', async () => {
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: true, failed: failedRoutes(0) });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('is incomplete when the read budget ran out', async () => {
    read.mockResolvedValue(readOf({ truncated: true }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('is incomplete when a value was cut at the byte cap', async () => {
    read.mockResolvedValue(readOf({ keys: [captured({ truncated: true })] }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({ complete: false });
  });

  it('is incomplete when nodes failed or keys vanished', async () => {
    const down = route();
    keysFor.mockResolvedValue({
      keys: ['lc:1', 'lc:2'],
      truncated: false,
      failed: new Set([down]),
    });
    read.mockResolvedValue(readOf({ failed: new Set([down]), missingKeys: 1 }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      failedNodes: 1,
      missingKeys: 1,
    });
  });

  it('counts a node that failed both the scan and the read once', async () => {
    const [b, c] = [route(), route()];
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: false, failed: new Set([b, c]) });
    read.mockResolvedValue(readOf({ failed: new Set([b]) }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({ failedNodes: 2 });
  });

  it('counts a node that failed the scan and another that failed the read', async () => {
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: false, failed: new Set([route()]) });
    read.mockResolvedValue(readOf({ failed: new Set([route()]) }));
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({ failedNodes: 2 });
  });

  it('answers not found when every key vanished before the read', async () => {
    read.mockResolvedValue(readOf({ keys: [], missingKeys: 1 }));
    await expect(service.getSession('conn-1', 'ns-1', 'lc:1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers unavailable when no keys were found and a primary failed', async () => {
    keysFor.mockResolvedValue({ keys: [], truncated: false, failed: failedRoutes(1) });
    await expect(service.getSession('conn-1', 'ns-1', 'lc:1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers unavailable when no key was read and a primary failed', async () => {
    read.mockResolvedValue(readOf({ keys: [], failed: failedRoutes(1), missingKeys: 1 }));
    await expect(service.getSession('conn-1', 'ns-1', 'lc:1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers not found for an unknown namespace', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce(null as never);
    await expect(service.getSession('conn-1', 'missing', 'lc:1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SessionExplorerService.oversizeSessions', () => {
  const scan = scanSessions as jest.MockedFunction<typeof scanSessions>;
  const storage = {
    getSessionNamespace: jest.fn(async () => ({ ...ns, oversizeThresholdBytes: 100 })),
  };
  const service = new SessionExplorerService(
    { get: jest.fn(() => ({})) } as never,
    storage as never,
  );
  const summary = (sessionId: string, memoryBytes: number, unmeasuredKeys = 0) => ({
    sessionId,
    keyCount: 1,
    memoryBytes,
    unmeasuredKeys,
    idleSeconds: null,
    ttlMs: null,
  });

  it('carries partial scans and unmeasured sessions into the response', async () => {
    scan.mockResolvedValue({
      sessions: [summary('big', 500), summary('unknown', 10, 1), summary('small', 10)],
      scannedKeys: 3,
      truncated: false,
      partial: true,
      failedNodes: 1,
      idleUntracked: false,
    });
    expect(await service.oversizeSessions('conn-1', 'ns-1')).toEqual({
      thresholdBytes: 100,
      sessionIds: ['big'],
      unmeasuredSessionIds: ['unknown'],
      truncated: false,
      partial: true,
      failedNodes: 1,
    });
  });
});

describe('SessionExplorerService.listSessions', () => {
  const scan = scanSessions as jest.MockedFunction<typeof scanSessions>;

  it('gives the agent-cache preset the namespace pattern', async () => {
    const storage = {
      getSessionNamespace: jest.fn(async () => ({
        ...ns,
        preset: 'agent-cache' as const,
        pattern: 'tenant:session:app:session:*',
      })),
    };
    const service = new SessionExplorerService(
      { get: jest.fn(() => ({})) } as never,
      storage as never,
    );
    scan.mockResolvedValue({
      sessions: [],
      scannedKeys: 0,
      truncated: false,
      partial: false,
      failedNodes: 0,
      idleUntracked: false,
    });
    await service.listSessions('conn-1', 'ns-1');
    const preset = scan.mock.lastCall![2];
    expect(preset.sessionIdOf('tenant:session:app:session:t1:prefs:lang')).toBe('t1');
    expect(preset.sessionIdOf('tenant:session:app:session:t1:checkpoint:abc')).toBe('t1');
  });
});

describe('SessionExplorerService.preview', () => {
  const input = { name: 'LangChain', pattern: 'lc:*', preset: 'langchain-community' };
  const failing = (message: string) => {
    const node = new FakeValkey();
    node.scan = async () => {
      throw new Error(message);
    };
    return node;
  };
  const serviceOver = (nodes: Record<number, FakeValkey>) => {
    ValkeyMock.mockImplementation((opts: { port: number }) => nodes[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: Object.keys(nodes).map((port) => masterNode(port, `10.0.0.1:${port}`)),
    });
    return new SessionExplorerService({ get: jest.fn(() => db) } as never, {} as never);
  };

  beforeEach(() => {
    ValkeyMock.mockReset();
    read.mockResolvedValue(readOf());
  });

  it('keeps searching the other primaries when one scan fails', async () => {
    const healthy = new FakeValkey(new Map([['lc:1', { type: 'list' }]]));
    const service = serviceOver({ 7001: failing('LOADING'), 7002: healthy });

    const result = await service.preview('conn-1', input);

    expect(result.sampleKey).toBe('lc:1');
  });

  it('does not claim an exhaustive search when it stopped at the first match', async () => {
    const service = serviceOver({ 7001: new FakeValkey(new Map([['lc:1', { type: 'list' }]])) });

    const result = await service.preview('conn-1', input);

    expect(result).toMatchObject({ sampleKey: 'lc:1', exhausted: false, touchesKeys: false });
  });

  it('counts a primary that failed while reading the sample', async () => {
    read.mockResolvedValueOnce(readOf({ keys: [], failed: failedRoutes(1) }));
    const service = serviceOver({ 7001: new FakeValkey(new Map([['lc:1', { type: 'list' }]])) });

    expect(await service.preview('conn-1', input)).toMatchObject({
      sampleKey: 'lc:1',
      view: null,
      failedNodes: 1,
    });
  });

  it('counts a primary that failed the search and another that failed the read', async () => {
    read.mockResolvedValueOnce(readOf({ failed: new Set([route()]) }));
    const healthy = new FakeValkey(new Map([['lc:1', { type: 'list' }]]));
    const service = serviceOver({ 7001: failing('LOADING'), 7002: healthy });

    expect(await service.preview('conn-1', input)).toMatchObject({
      sampleKey: 'lc:1',
      failedNodes: 2,
    });
  });

  it('says when reading the sample reset its access time', async () => {
    read.mockResolvedValueOnce(readOf({ touchesKeys: true }));
    const service = serviceOver({ 7001: new FakeValkey(new Map([['lc:1', { type: 'list' }]])) });

    expect((await service.preview('conn-1', input)).touchesKeys).toBe(true);
  });

  it('reports no failed nodes when every primary was searched', async () => {
    const service = serviceOver({ 7001: new FakeValkey(), 7002: new FakeValkey() });

    expect(await service.preview('conn-1', input)).toEqual({
      sampleKey: null,
      view: null,
      exhausted: true,
      failedNodes: 0,
      touchesKeys: false,
    });
  });

  it('reports an outage instead of no match when no primary can be reached', async () => {
    const down = () => Object.assign(new FakeValkey(), { connectError: new Error('ECONNREFUSED') });
    const service = serviceOver({ 7001: down(), 7002: down() });

    await expect(service.preview('conn-1', input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports an outage when the cluster has no serving primary', async () => {
    const service = serviceOver({});

    await expect(service.preview('conn-1', input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rethrows when every primary scan fails', async () => {
    const service = serviceOver({ 7001: failing('LOADING'), 7002: failing('LOADING') });

    await expect(service.preview('conn-1', input)).rejects.toThrow('LOADING');
  });

  it('does not report an exhaustive search when a primary scan fails', async () => {
    const service = serviceOver({ 7001: failing('LOADING'), 7002: new FakeValkey() });

    expect(await service.preview('conn-1', input)).toEqual({
      sampleKey: null,
      view: null,
      exhausted: false,
      failedNodes: 1,
      touchesKeys: false,
    });
  });

  it('does not report an exhaustive search when a primary could not be reached', async () => {
    const client = { scan: jest.fn(async () => ['0', []]) };
    jest.mocked(withPrimaries).mockImplementationOnce(async (_db, fn) =>
      fn({
        routes: [
          { slots: [[0, 16383]], client: client as never },
          { slots: [], client: null },
        ],
        touchesKeys: false,
        release: async () => undefined,
      }),
    );
    const service = new SessionExplorerService({ get: jest.fn(() => ({})) } as never, {} as never);
    const result = await service.preview('conn-1', {
      name: 'n',
      pattern: 'lc:*',
      preset: 'langchain-community',
    });
    expect(result).toEqual({
      sampleKey: null,
      view: null,
      exhausted: false,
      failedNodes: 1,
      touchesKeys: false,
    });
  });
});
