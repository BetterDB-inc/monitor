import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import type {
  CustomSchema,
  PresetId,
  SessionDetail,
  SessionExport,
  SessionListResponse,
  SessionNamespace,
  SessionNamespaceInput,
  SessionPreview,
  SessionSummary,
} from '@betterdb/shared';

const ENABLED = process.env.RUN_SESSION_EXPLORER_E2E === 'true';
const FIXTURE_PORT = '6380';
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures/session-explorer');
const SEED_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_NAMES = ['long', 'multi-turn', 'oversize', 'tool-call', 'ttl', 'unicode'];

interface Expectation {
  messages: number;
  roles: string[];
  contents?: string[];
}

interface Fixture {
  preset: PresetId;
  namespace: string;
  valkey: { port: number };
  expectations: Record<string, Expectation>;
}

const fixtures: Fixture[] = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));

const sessionNamed = (sessions: SessionSummary[], name: string) =>
  sessions.find((s) => s.sessionId === name || s.sessionId.endsWith(`:${name}`));

const describeE2E = ENABLED ? describe : describe.skip;

const sessionPath = (namespace: SessionNamespace, sessionId: string) =>
  `/session-explorer/namespaces/${namespace.id}/sessions/${encodeURIComponent(sessionId)}`;

describeE2E('Session Explorer against seeded library data (E2E)', () => {
  let app: NestFastifyApplication;
  const savedEnv = { host: process.env.DB_HOST, port: process.env.DB_PORT };

  beforeAll(async () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = FIXTURE_PORT;
    expect(fixtures.every((f) => String(f.valkey.port) === FIXTURE_PORT)).toBe(true);

    execFileSync('bash', [path.join(ROOT, 'scripts/session-fixtures/run.sh'), '--seed-only'], {
      stdio: 'inherit',
      timeout: SEED_TIMEOUT_MS,
    });

    const { createTestApp } = await import('./test-utils');
    app = await createTestApp();
    const health = await request(app.getHttpServer()).get('/health').expect(200);
    expect(health.body.database.port).toBe(Number(FIXTURE_PORT));
  }, SEED_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    await app?.close();
    process.env.DB_HOST = savedEnv.host;
    process.env.DB_PORT = savedEnv.port;
  });

  const createNamespace = async (input: SessionNamespaceInput) => {
    const created = await request(app.getHttpServer())
      .post('/session-explorer/namespaces')
      .send(input)
      .expect(201);
    const namespace: SessionNamespace = created.body;
    const res = await request(app.getHttpServer())
      .get(`/session-explorer/namespaces/${namespace.id}/sessions`)
      .expect(200);
    return { namespace, list: res.body as SessionListResponse };
  };

  const deleteNamespace = (namespace: SessionNamespace) =>
    request(app.getHttpServer()).delete(`/session-explorer/namespaces/${namespace.id}`);

  describe.each(fixtures.map((f) => [f.preset, f] as const))('%s', (_preset, fixture) => {
    const input: SessionNamespaceInput = {
      name: `e2e ${fixture.preset}`,
      pattern: fixture.namespace,
      preset: fixture.preset,
      customSchema: null,
      oversizeThresholdBytes: 1048576,
    };
    let namespace: SessionNamespace;
    let list: SessionListResponse;

    beforeAll(async () => {
      ({ namespace, list } = await createNamespace(input));
    });

    afterAll(() => deleteNamespace(namespace));

    it('lists all six seeded sessions', () => {
      expect(list.partial).toBe(false);
      for (const name of SESSION_NAMES) expect(sessionNamed(list.sessions, name)).toBeDefined();
    });

    it('reads the multi-turn session as seeded', async () => {
      const summary = sessionNamed(list.sessions, 'multi-turn') as SessionSummary;
      const res = await request(app.getHttpServer())
        .get(sessionPath(namespace, summary.sessionId))
        .expect(200);
      const detail: SessionDetail = res.body;
      const expected = fixture.expectations['multi-turn'];
      expect(detail.messages).toHaveLength(expected.messages);
      expect(detail.messages.map((m) => m.role)).toEqual(expected.roles);
      expect(detail.messages.map((m) => m.content)).toEqual(expected.contents);
    });

    it('reports a live TTL for the ttl session', () => {
      const ttl = sessionNamed(list.sessions, 'ttl')?.ttlMs;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
    });

    it('lists the oversize session above 1 MiB', () => {
      expect(sessionNamed(list.sessions, 'oversize')?.memoryBytes).toBeGreaterThan(1048576);
    });

    it('exports the multi-turn session with its raw keys', async () => {
      const summary = sessionNamed(list.sessions, 'multi-turn') as SessionSummary;
      const res = await request(app.getHttpServer())
        .get(`${sessionPath(namespace, summary.sessionId)}/export`)
        .expect(200);
      const exported: SessionExport = res.body;
      expect(exported.sessionId).toBe(summary.sessionId);
      expect(exported.namespace).toEqual({
        name: input.name,
        pattern: input.pattern,
        preset: input.preset,
      });
      expect(exported.keys.length).toBeGreaterThan(0);
      expect(exported.parsed.keys.map((k) => k.key)).toEqual(exported.keys.map((k) => k.key));
      expect(exported.parsed.messages).toHaveLength(fixture.expectations['multi-turn'].messages);
    });

    it('previews a parsed sample without touching keys', async () => {
      const res = await request(app.getHttpServer())
        .post('/session-explorer/namespaces/preview')
        .send(input)
        .expect(200);
      const preview: SessionPreview = res.body;
      expect(preview.sampleKey).not.toBeNull();
      expect(preview.view?.parsed).toBe(true);
      expect(preview.touchesKeys).toBe(false);
    });
  });

  describe('custom and raw presets over langchain-community keys', () => {
    const fixture = fixtures.find((f) => f.preset === 'langchain-community') as Fixture;
    const schema: CustomSchema = {
      valueType: 'list',
      messages: { from: 'items' },
      fields: { role: 'type', content: 'data.content' },
    };
    const created: SessionNamespace[] = [];

    afterAll(() => Promise.all(created.map(deleteNamespace)));

    it('reads the multi-turn session through a custom schema', async () => {
      const { namespace, list } = await createNamespace({
        name: 'e2e custom',
        pattern: fixture.namespace,
        preset: 'custom',
        customSchema: { ...schema, sessionTemplate: fixture.namespace.replace('*', '{session}') },
        oversizeThresholdBytes: 1048576,
      });
      created.push(namespace);
      expect(list.sessions.map((s) => s.sessionId).sort()).toEqual([...SESSION_NAMES].sort());

      const res = await request(app.getHttpServer())
        .get(sessionPath(namespace, 'multi-turn'))
        .expect(200);
      const detail: SessionDetail = res.body;
      const expected = fixture.expectations['multi-turn'];
      expect(detail.unparsedKeys).toBe(0);
      expect(detail.messages.map((m) => m.content).sort()).toEqual(
        [...(expected.contents ?? [])].sort(),
      );
    });

    it('shows every key as its own unparsed session under the raw preset', async () => {
      const { namespace, list } = await createNamespace({
        name: 'e2e raw',
        pattern: fixture.namespace,
        preset: 'raw',
        customSchema: null,
        oversizeThresholdBytes: 1048576,
      });
      created.push(namespace);
      const multiTurn = sessionNamed(list.sessions, 'multi-turn') as SessionSummary;
      expect(multiTurn.sessionId).toBe(fixture.namespace.replace('*', 'multi-turn'));

      const res = await request(app.getHttpServer())
        .get(sessionPath(namespace, multiTurn.sessionId))
        .expect(200);
      const detail: SessionDetail = res.body;
      expect(detail.messages).toEqual([]);
      expect(detail.keys).toHaveLength(1);
      expect(detail.keys[0].parsed).toBe(false);
    });
  });
});
