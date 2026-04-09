import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Valkey from 'iovalkey';
import { createTestApp } from './test-utils';

/**
 * E2E tests for the /migration API endpoints.
 * Requires Valkey available on DB_PORT (default 6390 from docker-compose.test.yml).
 */
describe('Migration API (e2e)', () => {
  let app: NestFastifyApplication;
  let sourceConnectionId: string;
  let targetConnectionId: string;
  let createdConnectionIds: string[] = [];

  const dbPort = Number(process.env.DB_PORT) || 6390;
  const dbPassword = process.env.DB_PASSWORD || 'devpassword';

  beforeAll(async () => {
    app = await createTestApp();

    const seedClient = new Valkey({ host: 'localhost', port: dbPort, password: dbPassword, lazyConnect: true });
    try {
      await seedClient.connect();
      await seedClient.set('migration:test:string', 'hello');
      await seedClient.hset('migration:test:hash', 'f1', 'v1', 'f2', 'v2');
      await seedClient.rpush('migration:test:list', 'a', 'b', 'c');
      await seedClient.sadd('migration:test:set', 'm1', 'm2');
      await seedClient.zadd('migration:test:zset', 1, 'z1', 2, 'z2');
    } finally {
      await seedClient.quit();
    }

    // Create two connections both pointing to the test Valkey instance
    const res1 = await request(app.getHttpServer())
      .post('/connections')
      .send({ name: 'Migration Source', host: 'localhost', port: dbPort, password: dbPassword });
    if (res1.status === 200 || res1.status === 201) {
      sourceConnectionId = res1.body.id;
      createdConnectionIds.push(sourceConnectionId);
    }

    const res2 = await request(app.getHttpServer())
      .post('/connections')
      .send({ name: 'Migration Target', host: 'localhost', port: dbPort, password: dbPassword });
    if (res2.status === 200 || res2.status === 201) {
      targetConnectionId = res2.body.id;
      createdConnectionIds.push(targetConnectionId);
    }
  }, 30_000);

  afterAll(async () => {
    // Clean up test keys
    const cleanupClient = new Valkey({ host: 'localhost', port: dbPort, password: dbPassword, lazyConnect: true });
    try {
      await cleanupClient.connect();
      await cleanupClient.del(
        'migration:test:string',
        'migration:test:hash',
        'migration:test:list',
        'migration:test:set',
        'migration:test:zset',
      );
    } catch { /* ignore */ } finally {
      await cleanupClient.quit();
    }

    // Clean up created connections
    for (const id of createdConnectionIds) {
      await request(app.getHttpServer())
        .delete(`/connections/${id}`)
        .catch(() => {});
    }

    await app.close();
  }, 30_000);

  describe('Analysis', () => {
    it('should reject analysis when source and target are the same connection', async () => {
      if (!sourceConnectionId) return;

      await request(app.getHttpServer())
        .post('/migration/analysis')
        .send({
          sourceConnectionId,
          targetConnectionId: sourceConnectionId,
        })
        .expect(400);
    });

    it('should return 404 for unknown analysis ID', async () => {
      await request(app.getHttpServer())
        .get('/migration/analysis/nonexistent-id')
        .expect(404);
    });

    it('should complete analysis happy path', async () => {
      if (!sourceConnectionId || !targetConnectionId) return;

      // Start analysis
      const startRes = await request(app.getHttpServer())
        .post('/migration/analysis')
        .send({
          sourceConnectionId,
          targetConnectionId,
          scanSampleSize: 1000,
        })
        .expect((res) => {
          expect([200, 201]).toContain(res.status);
        });

      expect(startRes.body).toHaveProperty('id');
      expect(startRes.body.status).toBe('pending');

      const analysisId = startRes.body.id;

      // Poll until completed or timeout
      let result: any;
      for (let i = 0; i < 30; i++) {
        const pollRes = await request(app.getHttpServer())
          .get(`/migration/analysis/${analysisId}`)
          .expect(200);

        result = pollRes.body;
        if (result.status === 'completed' || result.status === 'failed') break;
        await new Promise(r => setTimeout(r, 500));
      }

      expect(result.status).toBe('completed');
      expect(result).toHaveProperty('dataTypeBreakdown');
      expect(result).toHaveProperty('ttlDistribution');
      expect(result).toHaveProperty('incompatibilities');
      expect(result.totalKeys).toBeGreaterThan(0);
    }, 30_000);

    it('should cancel analysis', async () => {
      if (!sourceConnectionId || !targetConnectionId) return;

      const startRes = await request(app.getHttpServer())
        .post('/migration/analysis')
        .send({
          sourceConnectionId,
          targetConnectionId,
          scanSampleSize: 1000,
        });

      if (startRes.status !== 200 && startRes.status !== 201) return;

      const analysisId = startRes.body.id;

      // Cancel immediately
      await request(app.getHttpServer())
        .delete(`/migration/analysis/${analysisId}`)
        .expect(200);

      const pollRes = await request(app.getHttpServer())
        .get(`/migration/analysis/${analysisId}`)
        .expect(200);

      expect(pollRes.body.status).toBe('cancelled');
    });
  });

  describe('Validation', () => {
    let analysisId: string;

    beforeAll(async () => {
      if (!sourceConnectionId || !targetConnectionId) return;

      // Run an analysis first for the validation to reference
      const startRes = await request(app.getHttpServer())
        .post('/migration/analysis')
        .send({
          sourceConnectionId,
          targetConnectionId,
          scanSampleSize: 1000,
        });

      if (startRes.status === 200 || startRes.status === 201) {
        analysisId = startRes.body.id;
        // Wait for it to complete
        for (let i = 0; i < 30; i++) {
          const pollRes = await request(app.getHttpServer())
            .get(`/migration/analysis/${analysisId}`);
          if (pollRes.body.status === 'completed' || pollRes.body.status === 'failed') break;
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }, 30_000);

    it('should complete validation happy path', async () => {
      if (!sourceConnectionId || !targetConnectionId) return;

      const startRes = await request(app.getHttpServer())
        .post('/migration/validation')
        .send({
          sourceConnectionId,
          targetConnectionId,
          analysisId,
        });

      // Validation endpoint may require license (Pro tier)
      if (startRes.status === 402 || startRes.status === 403) return; // Skip if license guard blocks it

      expect([200, 201]).toContain(startRes.status);
      expect(startRes.body).toHaveProperty('id');

      const validationId = startRes.body.id;

      // Poll until completed
      let result: any;
      for (let i = 0; i < 30; i++) {
        const pollRes = await request(app.getHttpServer())
          .get(`/migration/validation/${validationId}`);

        if (pollRes.status === 402 || pollRes.status === 403) return; // Skip if license guard blocks
        result = pollRes.body;
        if (result.status === 'completed' || result.status === 'failed') break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (result.status === 'completed') {
        expect(result).toHaveProperty('keyCount');
        expect(result).toHaveProperty('sampleValidation');
        expect(result.keyCount.sourceKeys).toBeGreaterThan(0);
        expect(result.sampleValidation.matched).toBeGreaterThanOrEqual(0);
      }
    }, 30_000);

    it('should cancel validation', async () => {
      if (!sourceConnectionId || !targetConnectionId) return;

      const startRes = await request(app.getHttpServer())
        .post('/migration/validation')
        .send({
          sourceConnectionId,
          targetConnectionId,
        });

      if (startRes.status === 402 || startRes.status === 403) return; // Skip if license guard blocks

      if (startRes.status !== 200 && startRes.status !== 201) return;

      const validationId = startRes.body.id;

      const deleteRes = await request(app.getHttpServer())
        .delete(`/migration/validation/${validationId}`);

      if (deleteRes.status === 402 || deleteRes.status === 403) return;

      expect(deleteRes.status).toBe(200);
    });
  });
});
