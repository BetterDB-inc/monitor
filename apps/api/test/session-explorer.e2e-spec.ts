import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import type {
  PresetId,
  SessionDetail,
  SessionListResponse,
  SessionNamespace,
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

describeE2E('Session Explorer against seeded library data (E2E)', () => {
  let app: NestFastifyApplication;
  const savedEnv = { host: process.env.DB_HOST, port: process.env.DB_PORT };

  beforeAll(async () => {
    process.env.DB_HOST = 'localhost';
    process.env.DB_PORT = FIXTURE_PORT;
    expect(fixtures.every((f) => String(f.valkey.port) === FIXTURE_PORT)).toBe(true);

    execFileSync('zsh', [path.join(ROOT, 'scripts/session-fixtures/run.sh'), '--seed-only'], {
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

  describe.each(fixtures.map((f) => [f.preset, f] as const))('%s', (_preset, fixture) => {
    let namespace: SessionNamespace;
    let list: SessionListResponse;

    beforeAll(async () => {
      const created = await request(app.getHttpServer())
        .post('/session-explorer/namespaces')
        .send({
          name: `e2e ${fixture.preset}`,
          pattern: fixture.namespace,
          preset: fixture.preset,
          customSchema: null,
          oversizeThresholdBytes: 1048576,
        })
        .expect(201);
      namespace = created.body;
      const res = await request(app.getHttpServer())
        .get(`/session-explorer/namespaces/${namespace.id}/sessions`)
        .expect(200);
      list = res.body;
    });

    afterAll(async () => {
      await request(app.getHttpServer()).delete(`/session-explorer/namespaces/${namespace.id}`);
    });

    it('lists all six seeded sessions', () => {
      expect(list.partial).toBe(false);
      for (const name of SESSION_NAMES) expect(sessionNamed(list.sessions, name)).toBeDefined();
    });

    it('reads the multi-turn session as seeded', async () => {
      const summary = sessionNamed(list.sessions, 'multi-turn') as SessionSummary;
      const res = await request(app.getHttpServer())
        .get(
          `/session-explorer/namespaces/${namespace.id}/sessions/${encodeURIComponent(summary.sessionId)}`,
        )
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
  });
});
