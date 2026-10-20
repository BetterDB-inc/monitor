import { Logger } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { SessionNamespace } from '@betterdb/shared';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { SessionExplorerController } from '../session-explorer.controller';
import { SessionExplorerService } from '../session-explorer.service';
import { FakeEntry, FakeValkey, fakeDb } from './fake-valkey';

const human = (content: string) => JSON.stringify({ type: 'human', data: { content } });
const ai = (content: string) => JSON.stringify({ type: 'ai', data: { content } });

function memoryStorage() {
  const rows = new Map<string, SessionNamespace>();
  const calls: string[] = [];
  const storage = {
    calls,
    rows,
    listSessionNamespaces: jest.fn(async (connectionId: string) => {
      calls.push('listSessionNamespaces');
      return [...rows.values()].filter((r) => r.connectionId === connectionId);
    }),
    getSessionNamespace: jest.fn(async (connectionId: string, id: string) => {
      calls.push('getSessionNamespace');
      const row = rows.get(id);
      return row && row.connectionId === connectionId ? row : null;
    }),
    saveSessionNamespace: jest.fn(async (ns: SessionNamespace) => {
      calls.push('saveSessionNamespace');
      rows.set(ns.id, ns);
      return ns;
    }),
    deleteSessionNamespace: jest.fn(async (connectionId: string, id: string) => {
      calls.push('deleteSessionNamespace');
      const row = rows.get(id);
      if (!row || row.connectionId !== connectionId) return false;
      rows.delete(id);
      return true;
    }),
  };
  return storage;
}

const namespace = (overrides: Partial<SessionNamespace>): SessionNamespace => ({
  id: 'ns-raw',
  connectionId: 'conn-1',
  name: 'Raw chats',
  pattern: 'chat:*',
  preset: 'raw',
  customSchema: null,
  oversizeThresholdBytes: 1048576,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('SessionExplorerController', () => {
  let app: NestFastifyApplication;
  let storage: ReturnType<typeof memoryStorage>;
  let valkey: FakeValkey;

  const store = () =>
    new Map<string, FakeEntry>([
      ['chat:1', { type: 'string', pttl: 60000, memory: 120, value: 'hello SECRET-MARKER' }],
      ['chat:2', { type: 'hash', pttl: -1, memory: 90, value: { a: 'b' } }],
      [
        'lc:good',
        { type: 'list', pttl: 30000, memory: 200, value: [ai('hi there'), human('hello')] },
      ],
      [
        'lc:bad',
        { type: 'list', pttl: 30000, memory: 200, value: [ai('fine'), 'not json'] },
      ],
    ]);

  const headers = { 'x-connection-id': 'conn-1' };

  beforeEach(async () => {
    storage = memoryStorage();
    storage.rows.set('ns-raw', namespace({}));
    storage.rows.set(
      'ns-lc',
      namespace({ id: 'ns-lc', name: 'LangChain', pattern: 'lc:*', preset: 'langchain-community' }),
    );
    valkey = new FakeValkey(store());
    const registry = {
      get: () => fakeDb(valkey),
      getConfig: () => ({ connectionType: 'direct' }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [SessionExplorerController],
      providers: [
        SessionExplorerService,
        { provide: ConnectionRegistry, useValue: registry },
        { provide: 'STORAGE_CLIENT', useValue: storage },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const input = {
    name: 'Agent chats',
    pattern: 'agent:*',
    preset: 'raw',
    customSchema: null,
    oversizeThresholdBytes: 2048,
  };

  describe('namespace CRUD', () => {
    it('lists namespaces for the connection', async () => {
      const res = await app.inject({ method: 'GET', url: '/session-explorer/namespaces', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((n: SessionNamespace) => n.id).sort()).toEqual(['ns-lc', 'ns-raw']);
    });

    it('creates a namespace bound to the connection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/session-explorer/namespaces',
        headers,
        payload: input,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ ...input, connectionId: 'conn-1' });
      expect(typeof body.id).toBe('string');
      expect(storage.rows.get(body.id)).toEqual(body);
    });

    it('rejects a pattern without a literal prefix with the validation errors', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/session-explorer/namespaces',
        headers,
        payload: { ...input, pattern: '*' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toContain('Pattern must include a literal prefix');
      expect(storage.saveSessionNamespace).not.toHaveBeenCalled();
    });

    it('updates an existing namespace and keeps its identity', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/session-explorer/namespaces/ns-raw',
        headers,
        payload: input,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ...input, id: 'ns-raw', connectionId: 'conn-1', createdAt: 1 });
      expect(res.json().updatedAt).toBeGreaterThan(1);
    });

    it('answers 404 when updating an unknown namespace', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/session-explorer/namespaces/missing',
        headers,
        payload: input,
      });
      expect(res.statusCode).toBe(404);
    });

    it('answers 404 for a namespace owned by another connection', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions',
        headers: { 'x-connection-id': 'conn-2' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('deletes a namespace with 204 and answers 404 the second time', async () => {
      const first = await app.inject({
        method: 'DELETE',
        url: '/session-explorer/namespaces/ns-raw',
        headers,
      });
      expect(first.statusCode).toBe(204);
      const second = await app.inject({
        method: 'DELETE',
        url: '/session-explorer/namespaces/ns-raw',
        headers,
      });
      expect(second.statusCode).toBe(404);
    });
  });

  describe('preview', () => {
    it('parses one sampled key without persisting anything', async () => {
      valkey.scanPages = [['lc:good', 'lc:bad']];
      const res = await app.inject({
        method: 'POST',
        url: '/session-explorer/namespaces/preview',
        headers,
        payload: { ...input, pattern: 'lc:*', preset: 'langchain-community' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sampleKey).toBe('lc:good');
      expect(body.view.parsed).toBe(true);
      expect(body.view.key).toBe(body.sampleKey);
      expect(storage.calls).toEqual([]);
      expect(valkey.callsOf('scan')).toHaveLength(1);
    });

    it('answers nulls when no key matches', async () => {
      valkey.scanPages = [[]];
      const res = await app.inject({
        method: 'POST',
        url: '/session-explorer/namespaces/preview',
        headers,
        payload: input,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sampleKey: null, view: null });
    });

    it('rejects an invalid preview body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/session-explorer/namespaces/preview',
        headers,
        payload: { ...input, pattern: '*' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toContain('Pattern must include a literal prefix');
    });
  });

  describe('sessions', () => {
    it('lists sessions of a namespace', async () => {
      valkey.scanPages = [['chat:1', 'chat:2']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual([
        'chat:1',
        'chat:2',
      ]);
      expect(body).toMatchObject({ truncated: false, partial: false, failedNodes: 0 });
    });

    it('returns every key unparsed with a reason for the raw preset', async () => {
      valkey.scanPages = [['chat:1', 'chat:2']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.keys).toHaveLength(1);
      for (const key of body.keys) {
        expect(key).toMatchObject({ parsed: false, reason: 'No schema configured' });
      }
      expect(body.complete).toBe(false);
    });

    it('marks a fully parsed session complete', async () => {
      valkey.scanPages = [['lc:good', 'lc:bad']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-lc/sessions/lc%3Agood',
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
        'hello',
        'hi there',
      ]);
      expect(body).toMatchObject({ complete: true, unparsedKeys: 0, ttlMs: 30000, memoryBytes: 200 });
    });

    it('marks a session with an unparsed key incomplete', async () => {
      valkey.scanPages = [['lc:good', 'lc:bad']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-lc/sessions/lc%3Abad',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ complete: false, unparsedKeys: 1 });
    });

    it('answers 404 for a session with no keys without echoing its id', async () => {
      valkey.scanPages = [['chat:1']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3Aghost',
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('ghost');
    });
  });

  describe('export', () => {
    it('streams a JSON attachment holding every key as stored', async () => {
      valkey.scanPages = [['chat:1', 'chat:2']];
      const res = await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1/export',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toBe('attachment; filename="session-chat_1.json"');
      const body = JSON.parse(res.body);
      expect(body.namespace).toEqual({ name: 'Raw chats', pattern: 'chat:*', preset: 'raw' });
      expect(body.sessionId).toBe('chat:1');
      expect(typeof body.exportedAt).toBe('string');
      expect(body.keys).toEqual([
        expect.objectContaining({ key: 'chat:1', type: 'string', pttl: 60000, value: 'hello SECRET-MARKER' }),
      ]);
      expect(body.parsed.keys).toEqual([
        expect.objectContaining({ type: 'string', ttlMs: 60000, raw: 'hello SECRET-MARKER' }),
      ]);
    });
  });

  describe('privacy', () => {
    const contains = (args: unknown[]) =>
      args.some((a) => {
        try {
          return String(typeof a === 'string' ? a : JSON.stringify(a)).includes('SECRET-MARKER');
        } catch {
          return false;
        }
      });

    it('never logs session contents', async () => {
      const spies = [
        ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((m) =>
          jest.spyOn(Logger.prototype, m),
        ),
        ...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((m) =>
          jest.spyOn(Logger, m),
        ),
        ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m)),
      ];
      valkey.scanPages = [['chat:1']];
      await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1',
        headers,
      });
      await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1/export',
        headers,
      });
      for (const spy of spies) {
        for (const call of spy.mock.calls) expect(contains(call)).toBe(false);
      }
    });

    it('never persists session contents', async () => {
      valkey.scanPages = [['chat:1']];
      await app.inject({ method: 'GET', url: '/session-explorer/namespaces/ns-raw/sessions', headers });
      await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1',
        headers,
      });
      await app.inject({
        method: 'GET',
        url: '/session-explorer/namespaces/ns-raw/sessions/chat%3A1/export',
        headers,
      });
      expect(new Set(storage.calls)).toEqual(new Set(['getSessionNamespace']));
    });
  });
});
