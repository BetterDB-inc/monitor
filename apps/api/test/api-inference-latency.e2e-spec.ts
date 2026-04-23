import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Valkey from 'iovalkey';
import { createTestApp } from './test-utils';

/**
 * E2E for /inference-latency/profile against the test Valkey (:6390) which has
 * COMMANDLOG support but no Search module. Exercises capability Path 2:
 * hasCommandLog=true, hasVectorSearch=false.
 *
 * Path 1 (hasCommandLog=true, hasVectorSearch=true) requires swapping the
 * compose image to valkey/valkey-bundle — deliberately not covered here.
 */
describe('Inference Latency API (e2e)', () => {
  let app: NestFastifyApplication;
  const dbPort = Number(process.env.DB_PORT) || 6390;
  const dbPassword = process.env.DB_PASSWORD || 'devpassword';

  beforeAll(async () => {
    app = await createTestApp();

    const seed = new Valkey({
      host: 'localhost',
      port: dbPort,
      password: dbPassword,
      lazyConnect: true,
    });
    try {
      await seed.connect();
      // Ensure COMMANDLOG captures everything so we don't race on threshold defaults.
      await seed.call('COMMANDLOG', 'RESET', 'SLOW');
      await seed.call('CONFIG', 'SET', 'commandlog-execution-slower-than', '0');

      for (let i = 0; i < 20; i += 1) {
        await seed.get(`infer:test:k${i}`);
      }
      for (let i = 0; i < 20; i += 1) {
        await seed.set(`infer:test:k${i}`, 'v');
      }
    } finally {
      await seed.quit();
    }

    // Give the poller time to ingest entries into command_log_entries.
    await new Promise((r) => setTimeout(r, 2_000));
  }, 30_000);

  afterAll(async () => {
    const cleanup = new Valkey({
      host: 'localhost',
      port: dbPort,
      password: dbPassword,
      lazyConnect: true,
    });
    try {
      await cleanup.connect();
      for (let i = 0; i < 20; i += 1) {
        await cleanup.del(`infer:test:k${i}`);
      }
    } catch {
      /* ignore */
    } finally {
      await cleanup.quit();
    }
    await app.close();
  }, 30_000);

  describe('GET /inference-latency/profile', () => {
    it('returns a profile with the expected envelope for a COMMANDLOG-capable connection', async () => {
      const response = await request(app.getHttpServer())
        .get('/inference-latency/profile')
        .expect(200);

      const body = response.body;
      expect(body).toHaveProperty('connectionId');
      expect(typeof body.windowMs).toBe('number');
      expect(['commandlog', 'slowlog']).toContain(body.source);
      expect(['commandlog-execution-slower-than', 'slowlog-log-slower-than']).toContain(
        body.thresholdDirective,
      );
      expect(typeof body.thresholdUs).toBe('number');
      expect(Array.isArray(body.buckets)).toBe(true);
      expect(typeof body.generatedAt).toBe('number');

      for (const bucket of body.buckets) {
        expect(typeof bucket.bucket).toBe('string');
        expect(typeof bucket.p50).toBe('number');
        expect(typeof bucket.p95).toBe('number');
        expect(typeof bucket.p99).toBe('number');
        expect(typeof bucket.count).toBe('number');
        expect(typeof bucket.unhealthy).toBe('boolean');
        expect(Array.isArray(bucket.namedEvents)).toBe(true);
      }
    });

    it('omits FT.SEARCH buckets when the Search module is not loaded', async () => {
      const response = await request(app.getHttpServer())
        .get('/inference-latency/profile')
        .expect(200);

      const ftSearchBuckets = response.body.buckets.filter((b: { bucket: string }) =>
        b.bucket.startsWith('FT.SEARCH:'),
      );
      expect(ftSearchBuckets).toEqual([]);
    });

    it('returns 404 for an unknown x-connection-id', async () => {
      await request(app.getHttpServer())
        .get('/inference-latency/profile')
        .set('x-connection-id', 'definitely-not-a-real-connection-id')
        .expect(404);
    });
  });

  describe('GET /inference-latency/trend', () => {
    it('rejects malformed requests — 402 via LicenseGuard precedes param validation on community', async () => {
      const now = Date.now();
      const response = await request(app.getHttpServer())
        .get(`/inference-latency/trend?startTime=${now - 60_000}&endTime=${now}`);
      // On community, LicenseGuard returns 402 before BadRequest gets a chance.
      // On Pro, the controller raises 400 for the missing bucket.
      expect([400, 402]).toContain(response.status);
    });

    it('either serves the trend (when Pro is loaded) or 402s (community license)', async () => {
      const now = Date.now();
      const response = await request(app.getHttpServer())
        .get(
          `/inference-latency/trend?bucket=read&startTime=${now - 300_000}&endTime=${now}&bucketMs=60000`,
        );

      // Either behavior is valid depending on license state of the test environment.
      expect([200, 402]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body.bucket).toBe('read');
        expect(response.body.bucketMs).toBe(60_000);
        expect(Array.isArray(response.body.points)).toBe(true);
      }
    });
  });
});
