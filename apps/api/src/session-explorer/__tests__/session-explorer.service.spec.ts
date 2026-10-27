import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CapturedKey, SessionNamespace } from '@betterdb/shared';
import Valkey from 'iovalkey';
import { SessionExplorerService } from '../session-explorer.service';
import { keysForSession, scanSessions } from '../session-scanner';
import { readSessionKeys } from '../session-reader';
import { FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../session-scanner', () => ({
  ...jest.requireActual('../session-scanner'),
  keysForSession: jest.fn(),
  scanSessions: jest.fn(),
}));
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

  it('reads only the keys the preset selects from their names', async () => {
    storage.getSessionNamespace.mockResolvedValueOnce({ ...ns, preset: 'agent-cache' });
    const p = 'ac:session:t1';
    keysFor.mockResolvedValue({
      keys: [
        `${p}:checkpoint:1f0-a`,
        `${p}:checkpoint:1f0-b`,
        `${p}:__checkpoint_latest`,
        `${p}:writes:1f0-a|task-1|messages|0`,
        `${p}:writes:1f0-b|task-2|messages|0`,
      ],
      truncated: false,
      failedNodes: 0,
    });
    await service.getSession('conn-1', 'ns-1', 't1');
    expect(read).toHaveBeenLastCalledWith(expect.anything(), [
      `${p}:__checkpoint_latest`,
      `${p}:writes:1f0-b|task-2|messages|0`,
    ]);
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
    const service = new SessionExplorerService({ get: jest.fn(() => ({})) } as never, storage as never);
    scan.mockResolvedValue({
      sessions: [],
      scannedKeys: 0,
      truncated: false,
      partial: false,
      failedNodes: 0,
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
    read.mockResolvedValue({ keys: [captured()], truncated: false, failedNodes: 0, missingKeys: 0 });
  });

  it('keeps searching the other primaries when one scan fails', async () => {
    const healthy = new FakeValkey(new Map([['lc:1', { type: 'list' }]]));
    const service = serviceOver({ 7001: failing('LOADING'), 7002: healthy });

    const result = await service.preview('conn-1', input);

    expect(result.sampleKey).toBe('lc:1');
  });

  it('reports an outage instead of no match when no primary can be reached', async () => {
    const down = () => Object.assign(new FakeValkey(), { connectError: new Error('ECONNREFUSED') });
    const service = serviceOver({ 7001: down(), 7002: down() });

    await expect(service.preview('conn-1', input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rethrows when every primary scan fails', async () => {
    const service = serviceOver({ 7001: failing('LOADING'), 7002: failing('LOADING') });

    await expect(service.preview('conn-1', input)).rejects.toThrow('LOADING');
  });
});
