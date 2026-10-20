import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CapturedKey, SessionNamespace } from '@betterdb/shared';
import Valkey from 'iovalkey';
import { SessionExplorerService } from '../session-explorer.service';
import { keysForSession, scanSessions } from '../session-scanner';
import { readSessionKeys } from '../session-reader';
import { withPrimaries } from '../primary-nodes';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../session-scanner', () => ({
  ...jest.requireActual('../session-scanner'),
  keysForSession: jest.fn(),
  scanSessions: jest.fn(),
}));
jest.mock('../primary-nodes', () => {
  const actual = jest.requireActual('../primary-nodes');
  return { ...actual, withPrimaries: jest.fn(actual.withPrimaries) };
});
jest.mock('../session-reader', () => ({
  ...jest.requireActual('../session-reader'),
  readSessionKeys: jest.fn(),
}));

const keysFor = keysForSession as jest.MockedFunction<typeof keysForSession>;
const read = readSessionKeys as jest.MockedFunction<typeof readSessionKeys>;
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

describe('SessionExplorerService.getSession', () => {
  const storage = { getSessionNamespace: jest.fn(async () => ns) };
  const registry = { get: jest.fn(() => ({})) };
  const service = new SessionExplorerService(registry as never, storage as never);

  beforeEach(() => {
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: false, failedNodes: 0 });
    read.mockResolvedValue({ keys: [captured()], truncated: false, failedNodes: 0, missingKeys: 0 });
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

  it('is incomplete when the key scan was capped', async () => {
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: true, failedNodes: 0 });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('is incomplete when the read budget ran out', async () => {
    read.mockResolvedValue({ keys: [captured()], truncated: true, failedNodes: 0, missingKeys: 0 });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('is incomplete when a value was cut at the byte cap', async () => {
    read.mockResolvedValue({
      keys: [captured({ truncated: true })],
      truncated: false,
      failedNodes: 0,
      missingKeys: 0,
    });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({ complete: false });
  });

  it('is incomplete when nodes failed or keys vanished', async () => {
    keysFor.mockResolvedValue({ keys: ['lc:1', 'lc:2'], truncated: false, failedNodes: 1 });
    read.mockResolvedValue({ keys: [captured()], truncated: false, failedNodes: 1, missingKeys: 1 });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({
      complete: false,
      failedNodes: 1,
      missingKeys: 1,
    });
  });

  it('counts a node that failed both the scan and the read once', async () => {
    keysFor.mockResolvedValue({ keys: ['lc:1'], truncated: false, failedNodes: 2 });
    read.mockResolvedValue({ keys: [captured()], truncated: false, failedNodes: 1, missingKeys: 0 });
    expect(await service.getSession('conn-1', 'ns-1', 'lc:1')).toMatchObject({ failedNodes: 2 });
  });

  it('answers not found when every key vanished before the read', async () => {
    read.mockResolvedValue({ keys: [], truncated: false, failedNodes: 0, missingKeys: 1 });
    await expect(service.getSession('conn-1', 'ns-1', 'lc:1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers unavailable when no keys were found and a primary failed', async () => {
    keysFor.mockResolvedValue({ keys: [], truncated: false, failedNodes: 1 });
    await expect(service.getSession('conn-1', 'ns-1', 'lc:1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('answers unavailable when no key was read and a primary failed', async () => {
    read.mockResolvedValue({ keys: [], truncated: false, failedNodes: 1, missingKeys: 1 });
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
  const service = new SessionExplorerService({ get: jest.fn(() => ({})) } as never, storage as never);
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
    read.mockResolvedValue({ keys: [captured()], truncated: false, failedNodes: 0, missingKeys: 0 });
  });

  it('keeps searching the other primaries when one scan fails', async () => {
    const healthy = new FakeValkey(new Map([['lc:1', { type: 'list' }]]));
    const service = serviceOver({ 7001: failing('LOADING'), 7002: healthy });

    const result = await service.preview('conn-1', input);

    expect(result.sampleKey).toBe('lc:1');
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
    });
  });

  it('does not report an exhaustive search when a primary could not be reached', async () => {
    const client = { scan: jest.fn(async () => ['0', []]) };
    jest.mocked(withPrimaries).mockImplementationOnce(async (_db, fn) =>
      fn({ clients: [client as never], failed: 1, routes: null, release: async () => undefined }),
    );
    const service = new SessionExplorerService({ get: jest.fn(() => ({})) } as never, {} as never);
    const result = await service.preview('conn-1', { name: 'n', pattern: 'lc:*', preset: 'langchain-community' });
    expect(result).toEqual({ sampleKey: null, view: null, exhausted: false });
  });
});
