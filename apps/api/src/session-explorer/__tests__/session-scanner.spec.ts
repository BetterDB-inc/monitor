import { ServiceUnavailableException } from '@nestjs/common';
import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { PresetDefinition } from '../presets/types';
import { primaryClients } from '../primary-nodes';
import { keysForSession, scanSessions, type SessionKeysResult } from '../session-scanner';
import { clientsOf, FakeEntry, FakeValkey, fakeDb, masterNode } from './fake-valkey';

jest.mock('iovalkey', () => ({ __esModule: true, default: jest.fn() }));

const ValkeyMock = Valkey as unknown as jest.Mock;

const preset: PresetDefinition = {
  id: 'custom',
  defaultPattern: (prefix) => `${prefix}*`,
  sessionIdOf: (key) => /^s:([^:]+):/.exec(key)?.[1] ?? null,
  parseKey: () => {
    throw new Error('not used');
  },
  mergeSession: () => [],
};

const keyRange = (from: number, count: number, session = 'a') =>
  Array.from({ length: count }, (_, i) => `s:${session}:${from + i}`);

const counted = (result: SessionKeysResult) => ({ ...result, failed: result.failed.size });

const storeOf = (entries: Record<string, FakeEntry>) => new Map(Object.entries(entries));

describe('scanSessions', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('stops at keyCap and sets truncated', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 5000), keyRange(5000, 5000), keyRange(10000, 5000)];
    for (const page of client.scanPages) {
      for (const key of page) client.store.set(key, { type: 'string' });
    }

    const result = await scanSessions(fakeDb(client), 's:*', preset, { keyCap: 10000 });

    expect(result.scannedKeys).toBe(10000);
    expect(result.truncated).toBe(true);
    expect(client.reader.callsOf('scan')).toHaveLength(3);
    expect(result.sessions).toEqual([expect.objectContaining({ sessionId: 'a', keyCount: 10000 })]);
  });

  it('applies the key cap as a total across primaries', async () => {
    const nodes = [7001, 7002, 7003].map((port, n) => {
      const node = new FakeValkey();
      node.scanPages = [keyRange(n * 5000, 5000)];
      for (const key of node.scanPages[0]) node.store.set(key, { type: 'string' });
      return node;
    });
    const byPort: Record<number, FakeValkey> = { 7001: nodes[0], 7002: nodes[1], 7003: nodes[2] };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: [
        masterNode('a', '10.0.0.1:7001'),
        masterNode('b', '10.0.0.2:7002'),
        masterNode('c', '10.0.0.3:7003'),
      ],
    });

    const result = await scanSessions(db, 's:*', preset, { keyCap: 10000 });

    expect(result.scannedKeys).toBe(10000);
    expect(result.truncated).toBe(true);
    expect(nodes[2].callsOf('scan')).toHaveLength(1);
    expect(nodes.every((n) => n.disconnected)).toBe(true);
  });

  it('sets truncated when the last page holds more keys than the cap', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 3)];
    for (const key of client.scanPages[0]) client.store.set(key, { type: 'string' });

    const result = await scanSessions(fakeDb(client), 's:*', preset, { keyCap: 2 });

    expect(result.scannedKeys).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when the last page fills the cap exactly', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 2)];
    for (const key of client.scanPages[0]) client.store.set(key, { type: 'string' });

    const result = await scanSessions(fakeDb(client), 's:*', preset, { keyCap: 2 });

    expect(result.truncated).toBe(false);
  });

  it('is not truncated when the cap fills at a page boundary and nothing follows', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 2), []];
    for (const key of client.scanPages[0]) client.store.set(key, { type: 'string' });

    const result = await scanSessions(fakeDb(client), 's:*', preset, { keyCap: 2 });

    expect(result.scannedKeys).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('is not truncated when the cap fills on a primary and the rest are empty', async () => {
    const pages = [keyRange(0, 2), []];
    const nodes = pages.map((page) => {
      const node = new FakeValkey();
      node.scanPages = [page];
      for (const key of page) node.store.set(key, { type: 'string' });
      return node;
    });
    const byPort: Record<number, FakeValkey> = { 7001: nodes[0], 7002: nodes[1] };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const result = await scanSessions(db, 's:*', preset, { keyCap: 2 });

    expect(result.scannedKeys).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('is not truncated when the scan completes under the cap', async () => {
    const client = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    const result = await scanSessions(fakeDb(client), 's:*', preset);
    expect(result.truncated).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.failedNodes).toBe(0);
  });

  it('never calls KEYS', async () => {
    const client = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    await scanSessions(fakeDb(client), 's:*', preset);
    expect(client.reader.callsOf('keys')).toHaveLength(0);
    expect(client.reader.calls.some((c) => c.name.toLowerCase().includes('keys'))).toBe(false);
  });

  it('uses MATCH and COUNT 1000', async () => {
    const client = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    await scanSessions(fakeDb(client), 's:*', preset);
    expect(client.reader.callsOf('scan')[0].args).toEqual(['0', 'MATCH', 's:*', 'COUNT', 1000]);
  });

  it('pipelines metadata', async () => {
    const entries: Record<string, FakeEntry> = {};
    for (const key of keyRange(0, 2500)) entries[key] = { type: 'string' };
    const client = new FakeValkey(storeOf(entries));

    const result = await scanSessions(fakeDb(client), 's:*', preset, { batch: 1000 });

    expect(client.reader.pipelineExecs).toBe(3);
    expect(client.reader.callsOf('type')).toHaveLength(0);
    expect(client.reader.callsOf('pipeline.type')).toHaveLength(2500);
    expect(client.reader.callsOf('pipeline.pttl')).toHaveLength(2500);
    expect(client.reader.callsOf('pipeline.memory')[0].args).toEqual(['USAGE', 's:a:0']);
    expect(client.reader.callsOf('pipeline.object')[0].args).toEqual(['IDLETIME', 's:a:0']);
    expect(result.sessions[0].keyCount).toBe(2500);
  });

  it('skips keys that vanished between scan and metadata', async () => {
    const client = new FakeValkey(
      storeOf({
        's:a:1': { type: 'string', memory: 10 },
        's:a:2': { type: 'string', memory: 20 },
        's:b:1': { type: 'string', memory: 5 },
      }),
    );
    client.scanPages = [['s:a:1', 's:a:2', 's:a:gone', 's:c:gone', 's:b:1']];

    const result = await scanSessions(fakeDb(client), 's:*', preset);

    expect(result.scannedKeys).toBe(5);
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    const a = result.sessions.find((s) => s.sessionId === 'a');
    expect(a).toMatchObject({ keyCount: 2, memoryBytes: 30 });
  });

  it('drops keys the preset does not recognise', async () => {
    const client = new FakeValkey(
      storeOf({ 's:a:1': { type: 'string' }, stray: { type: 'string' } }),
    );
    const result = await scanSessions(fakeDb(client), '*', preset);
    expect(result.sessions).toHaveLength(1);
    expect(client.reader.callsOf('pipeline.type').map((c) => c.args[0])).toEqual(['s:a:1']);
  });

  it('aggregates memory as sum and idle as min', async () => {
    const client = new FakeValkey(
      storeOf({
        's:a:1': { type: 'string', memory: 100, idle: 50 },
        's:a:2': { type: 'list', memory: 300, idle: 7 },
      }),
    );
    const [session] = (await scanSessions(fakeDb(client), 's:*', preset)).sessions;
    expect(session).toMatchObject({ memoryBytes: 400, idleSeconds: 7 });
  });

  it('counts keys whose MEMORY USAGE failed instead of sizing them as zero', async () => {
    const client = new FakeValkey(
      storeOf({
        's:a:1': { type: 'string', memory: 100 },
        's:a:2': { type: 'string', memory: null },
      }),
    );
    const [session] = (await scanSessions(fakeDb(client), 's:*', preset)).sessions;
    expect(session).toMatchObject({ memoryBytes: 100, unmeasuredKeys: 1 });
  });

  it('ttl is null when no key expires', async () => {
    const client = new FakeValkey(
      storeOf({ 's:a:1': { type: 'string', pttl: -1 }, 's:a:2': { type: 'string', pttl: -1 } }),
    );
    const [session] = (await scanSessions(fakeDb(client), 's:*', preset)).sessions;
    expect(session.ttlMs).toBeNull();
  });

  it('ttl is the smallest positive PTTL', async () => {
    const client = new FakeValkey(
      storeOf({
        's:a:1': { type: 'string', pttl: -1 },
        's:a:2': { type: 'string', pttl: 9000 },
        's:a:3': { type: 'string', pttl: 4000 },
      }),
    );
    const [session] = (await scanSessions(fakeDb(client), 's:*', preset)).sessions;
    expect(session.ttlMs).toBe(4000);
  });

  it('flags partial results when a primary fails', async () => {
    const parent = new FakeValkey(new Map(), { host: 'seed', port: 7000, password: 'pw' });
    const nodeA = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    const nodeB = new FakeValkey(storeOf({ 's:b:1': { type: 'string' } }));
    const nodeC = new FakeValkey(storeOf({ 's:c:1': { type: 'string' } }));
    nodeC.connectError = new Error('ECONNREFUSED');
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB, 7003: nodeC };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);

    const db = fakeDb(parent, {
      nodes: [
        masterNode('a', '10.0.0.1:7001'),
        masterNode('b', '10.0.0.2:7002'),
        masterNode('c', '10.0.0.3:7003'),
      ],
    });
    const result = await scanSessions(db, 's:*', preset);

    expect(result.partial).toBe(true);
    expect(result.failedNodes).toBe(1);
    expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    expect(ValkeyMock).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw' }));
    expect([nodeA, nodeB, nodeC].every((n) => n.disconnected)).toBe(true);
    expect(parent.disconnected).toBe(false);
  });

  it('counts a key seen on two primaries during slot migration once', async () => {
    const nodeA = new FakeValkey(storeOf({ 's:a:1': { type: 'string', memory: 10 } }));
    const nodeB = new FakeValkey(storeOf({ 's:a:1': { type: 'string', memory: 10 } }));
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const result = await scanSessions(db, 's:*', preset);

    expect(result.scannedKeys).toBe(1);
    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: 'a', keyCount: 1, memoryBytes: 10 }),
    ]);
  });

  it('says idle time is not tracked under an LFU eviction policy', async () => {
    const client = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    client.lfu = true;

    const result = await scanSessions(fakeDb(client), 's:*', preset);

    expect(result.idleUntracked).toBe(true);
    expect(result.sessions[0].idleSeconds).toBeNull();
  });

  it('says idle time is tracked otherwise', async () => {
    const client = new FakeValkey(storeOf({ 's:a:1': { type: 'string', idle: 5 } }));

    const result = await scanSessions(fakeDb(client), 's:*', preset);

    expect(result.idleUntracked).toBe(false);
  });

  it('counts a primary whose scan fails as failed', async () => {
    const parent = new FakeValkey();
    const nodeA = new FakeValkey(storeOf({ 's:a:1': { type: 'string' } }));
    const nodeB = new FakeValkey();
    nodeB.scan = async () => {
      throw new Error('LOADING');
    };
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(parent, {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const result = await scanSessions(db, 's:*', preset);

    expect(result).toMatchObject({ partial: true, failedNodes: 1 });
    expect(result.sessions).toHaveLength(1);
  });

  it('reports the server unavailable when its reader cannot connect', async () => {
    const client = new FakeValkey();
    const reader = new FakeValkey();
    reader.connectError = new Error('ERR max number of clients reached');
    client.duplicateWith = reader;
    await expect(scanSessions(fakeDb(client), 's:*', preset)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('rethrows when the only node fails', async () => {
    const client = new FakeValkey();
    const reader = new FakeValkey();
    reader.scan = async () => {
      throw new Error('NOAUTH');
    };
    client.duplicateWith = reader;
    await expect(scanSessions(fakeDb(client), 's:*', preset)).rejects.toThrow('NOAUTH');
    expect(client.disconnected).toBe(false);
    expect(reader.disconnected).toBe(true);
  });
});

describe('primaryClients', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('reads standalone through a reader it closes, never the parent', async () => {
    const parent = new FakeValkey();
    const reader = new FakeValkey();
    parent.duplicateWith = reader;
    const result = await primaryClients(fakeDb(parent));
    expect(result.routes).toEqual([{ slots: [[0, 16383]], client: reader }]);
    await result.release();
    expect(reader.disconnected).toBe(true);
    expect(parent.disconnected).toBe(false);
    expect(ValkeyMock).not.toHaveBeenCalled();
  });

  it('keeps only masters with slots and connects to the others by their own address', async () => {
    const parent = new FakeValkey();
    const nodeA = new FakeValkey();
    const nodeB = new FakeValkey();
    parent.duplicateWith = nodeA;
    ValkeyMock.mockImplementationOnce(() => nodeB);
    const replica = { ...masterNode('r', '10.0.0.9:7009'), flags: ['slave'], master: 'a' };
    const empty = { ...masterNode('e', '10.0.0.8:7008'), slots: [] };
    const db = fakeDb(parent, {
      nodes: [
        masterNode('a', '10.0.0.1:7000', ['myself']),
        masterNode('b', '10.0.0.2:7002'),
        replica,
        empty,
      ],
    });

    const result = await primaryClients(db);

    expect(clientsOf(result)).toEqual([nodeA, nodeB]);
    expect(ValkeyMock).toHaveBeenCalledTimes(1);
    expect(ValkeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.2', port: 7002, lazyConnect: true }),
    );
    await result.release();
    expect(nodeA.disconnected).toBe(true);
    expect(nodeB.disconnected).toBe(true);
    expect(parent.disconnected).toBe(false);
  });
});

describe('keysForSession', () => {
  beforeEach(() => ValkeyMock.mockReset());

  it('scans every primary and returns only the session keys', async () => {
    const parent = new FakeValkey();
    const nodeA = new FakeValkey(
      storeOf({ 's:x:1': { type: 'string' }, 's:y:1': { type: 'string' } }),
    );
    const nodeB = new FakeValkey(
      storeOf({ 's:x:2': { type: 'string' }, other: { type: 'string' } }),
    );
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(parent, {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const result = await keysForSession(db, 's:*', preset, 'x');

    expect(result.keys.sort()).toEqual(['s:x:1', 's:x:2']);
    expect(counted(result)).toMatchObject({ truncated: false, failed: 0 });
    expect(nodeA.disconnected && nodeB.disconnected).toBe(true);
  });

  it('respects the key cap', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 5000, 'x'), keyRange(5000, 5000, 'x')];
    const result = await keysForSession(fakeDb(client), 's:*', preset, 'x', 3000);
    expect(result.keys).toHaveLength(3000);
    expect(result.truncated).toBe(true);
    expect(client.reader.callsOf('scan')).toHaveLength(1);
  });

  it('finds session keys past the cap of non-matching keys', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 5000, 'y'), keyRange(5000, 5000, 'y'), ['s:x:1']];
    const result = await keysForSession(fakeDb(client), 's:*', preset, 'x', 3000);
    expect(result).toMatchObject({ keys: ['s:x:1'], truncated: false });
  });

  it('reports primaries that could not be reached or scanned', async () => {
    const nodeA = new FakeValkey(storeOf({ 's:x:1': { type: 'string' } }));
    const nodeB = new FakeValkey();
    nodeB.connectError = new Error('ECONNREFUSED');
    const nodeC = new FakeValkey();
    nodeC.scan = async () => {
      throw new Error('LOADING');
    };
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB, 7003: nodeC };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: [
        masterNode('a', '10.0.0.1:7001'),
        masterNode('b', '10.0.0.2:7002'),
        masterNode('c', '10.0.0.3:7003'),
      ],
    });

    const result = await keysForSession(db, 's:*', preset, 'x');

    expect(counted(result)).toEqual({ keys: ['s:x:1'], truncated: false, failed: 2 });
  });

  const byKey: PresetDefinition = {
    ...preset,
    sessionIdOf: (key) => key,
    sessionLookup: (sessionId) => ({ key: sessionId }),
  };

  it('looks a session key up directly instead of scanning', async () => {
    const client = new FakeValkey(storeOf({ 'chat:1': { type: 'list', value: [] } }));

    const result = await keysForSession(fakeDb(client), 'chat:*', byKey, 'chat:1');

    expect(counted(result)).toEqual({ keys: ['chat:1'], truncated: false, failed: 0 });
    expect(client.reader.callsOf('scan')).toHaveLength(0);
  });

  it('finds no session for a key outside the namespace pattern', async () => {
    const client = new FakeValkey(storeOf({ 'other:1': { type: 'list', value: [] } }));

    const result = await keysForSession(fakeDb(client), 'chat:*', byKey, 'other:1');

    expect(result.keys).toEqual([]);
    expect(client.reader.callsOf('exists')).toHaveLength(0);
    expect(client.reader.callsOf('scan')).toHaveLength(0);
  });

  it('finds no session for a key that does not exist', async () => {
    const client = new FakeValkey();

    const result = await keysForSession(fakeDb(client), 'chat:*', byKey, 'chat:1');

    expect(counted(result)).toEqual({ keys: [], truncated: false, failed: 0 });
  });

  it('looks a session key up on the primary that owns its slot', async () => {
    const nodeA = new FakeValkey();
    const nodeB = new FakeValkey(storeOf({ 'chat:1': { type: 'list', value: [] } }));
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const slot = calculateSlot('chat:1');
    const db = fakeDb(new FakeValkey(), {
      nodes: [
        masterNode('a', '10.0.0.1:7001', [], [[(slot + 1) % 16384, (slot + 1) % 16384]]),
        masterNode('b', '10.0.0.2:7002', [], [[slot, slot]]),
      ],
    });

    const result = await keysForSession(db, 'chat:*', byKey, 'chat:1');

    expect(result.keys).toEqual(['chat:1']);
    expect(nodeA.callsOf('exists')).toHaveLength(0);
  });

  const splitCluster = (owner: FakeValkey, other: FakeValkey) => {
    const byPort: Record<number, FakeValkey> = { 7001: other, 7002: owner };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const slot = calculateSlot('chat:1');
    return fakeDb(new FakeValkey(), {
      nodes: [
        masterNode('a', '10.0.0.1:7001', [], [[(slot + 1) % 16384, (slot + 1) % 16384]]),
        masterNode('b', '10.0.0.2:7002', [], [[slot, slot]]),
      ],
    });
  };

  it('finds no session when its owner answers but another primary is down', async () => {
    const down = new FakeValkey();
    down.connectError = new Error('ECONNREFUSED');

    const result = await keysForSession(
      splitCluster(new FakeValkey(), down),
      'chat:*',
      byKey,
      'chat:1',
    );

    expect(counted(result)).toEqual({ keys: [], truncated: false, failed: 0 });
  });

  it('counts the owner once when it is the primary that is down', async () => {
    const down = new FakeValkey();
    down.connectError = new Error('ECONNREFUSED');

    const result = await keysForSession(
      splitCluster(down, new FakeValkey()),
      'chat:*',
      byKey,
      'chat:1',
    );

    expect(counted(result)).toEqual({ keys: [], truncated: false, failed: 1 });
  });

  it('reports the owning primary as failed when the lookup errors', async () => {
    const client = new FakeValkey(storeOf({ 'chat:1': { type: 'list', value: [] } }));
    client.movedKeys.add('chat:1');

    const result = await keysForSession(fakeDb(client), 'chat:*', byKey, 'chat:1');

    expect(counted(result)).toEqual({ keys: [], truncated: false, failed: 1 });
  });

  it('reports a session key whose slot no primary owns as a failure', async () => {
    const node = new FakeValkey(storeOf({ 'chat:1': { type: 'list', value: [] } }));
    ValkeyMock.mockImplementation(() => node);
    const slot = calculateSlot('chat:1');
    const db = fakeDb(new FakeValkey(), {
      nodes: [masterNode('a', '10.0.0.1:7001', [], [[(slot + 1) % 16384, (slot + 1) % 16384]])],
    });

    const result = await keysForSession(db, 'chat:*', byKey, 'chat:1');

    expect(counted(result)).toEqual({ keys: [], truncated: false, failed: 1 });
    expect(node.callsOf('exists')).toHaveLength(0);
  });

  const byMatch: PresetDefinition = {
    ...preset,
    sessionLookup: (sessionId) => ({ match: `s:${sessionId}:*` }),
  };

  it('scans with a MATCH built from the session id', async () => {
    const client = new FakeValkey(storeOf({ 's:x:1': { type: 'string' } }));

    await keysForSession(fakeDb(client), 's:*', byMatch, 'x');

    expect(client.reader.callsOf('scan')[0].args).toEqual(['0', 'MATCH', 's:x:*', 'COUNT', 1000]);
  });

  it('keeps only session keys inside the namespace pattern', async () => {
    const client = new FakeValkey(
      storeOf({
        's:x:1': { type: 'string' },
        's:x:2': { type: 'string' },
        's:y:1': { type: 'string' },
      }),
    );

    const result = await keysForSession(fakeDb(client), 's:*:1', byMatch, 'x');

    expect(result.keys).toEqual(['s:x:1']);
  });

  it('stops scanning for a session after the page budget', async () => {
    const client = new FakeValkey();
    client.scanPages = [keyRange(0, 10, 'y'), keyRange(10, 10, 'y'), ['s:x:1'], ['s:x:2']];

    const result = await keysForSession(fakeDb(client), 's:*', preset, 'x', 10_000, 2);

    expect(client.reader.callsOf('scan')).toHaveLength(2);
    expect(counted(result)).toEqual({ keys: [], truncated: true, failed: 0 });
  });

  it('lists a key seen on two primaries during slot migration once', async () => {
    const nodeA = new FakeValkey(storeOf({ 's:x:1': { type: 'string' } }));
    const nodeB = new FakeValkey(storeOf({ 's:x:1': { type: 'string' } }));
    const byPort: Record<number, FakeValkey> = { 7001: nodeA, 7002: nodeB };
    ValkeyMock.mockImplementation((opts: { port: number }) => byPort[opts.port]);
    const db = fakeDb(new FakeValkey(), {
      nodes: [masterNode('a', '10.0.0.1:7001'), masterNode('b', '10.0.0.2:7002')],
    });

    const result = await keysForSession(db, 's:*', preset, 'x');

    expect(result.keys).toEqual(['s:x:1']);
  });
});
