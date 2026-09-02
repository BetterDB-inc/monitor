import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp, isValkeyDatabase, HealthResponse, waitForConnectionCleanup } from './test-utils';

describe('Full Flow E2E Test', () => {
  let app: NestFastifyApplication;
  let healthResponse: HealthResponse;

  beforeAll(async () => {
    app = await createTestApp();
    // Fetch health once for all tests that need it
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    healthResponse = res.body as HealthResponse;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('End-to-end workflow', () => {
    it('should complete full monitoring workflow: health → metrics → prometheus → client analytics', async () => {
      // 1. Check health
      const healthRes = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(healthRes.body.status).toBe('connected');
      expect(healthRes.body).toHaveProperty('database');
      expect(healthRes.body.database).toHaveProperty('type');
      expect(healthRes.body.database).toHaveProperty('version');

      // 2. Fetch metrics
      const infoRes = await request(app.getHttpServer())
        .get('/metrics/info')
        .expect(200);

      expect(infoRes.body).toHaveProperty('server');
      expect(infoRes.body).toHaveProperty('memory');

      // 3. Check prometheus metrics
      const prometheusRes = await request(app.getHttpServer())
        .get('/prometheus/metrics')
        .expect(200);

      expect(prometheusRes.text).toContain('# HELP');
      expect(prometheusRes.text).toContain('betterdb_');

      // 4. Verify client analytics
      const analyticsRes = await request(app.getHttpServer())
        .get('/client-analytics/stats')
        .expect(200);

      expect(analyticsRes.body).toHaveProperty('currentConnections');
      expect(typeof analyticsRes.body.currentConnections).toBe('number');

      // 5. Check settings
      const settingsRes = await request(app.getHttpServer())
        .get('/settings')
        .expect(200);

      expect(settingsRes.body).toHaveProperty('settings');
    });

    it('should handle Valkey-specific features based on database type', async () => {
      const isValkey = isValkeyDatabase(healthResponse);

      const commandlogRes = await request(app.getHttpServer())
        .get('/metrics/commandlog');

      if (isValkey && healthResponse.capabilities?.hasCommandLog) {
        // Valkey with commandlog support should return 200
        expect(commandlogRes.status).toBe(200);
        expect(Array.isArray(commandlogRes.body)).toBe(true);
      } else {
        // Redis or Valkey without support should return 501 Not Implemented
        expect(commandlogRes.status).toBe(501);
      }
    });

    it('should provide consistent database information across endpoints', async () => {
      const healthRes = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      const dbType = healthRes.body.database.type;
      expect(['valkey', 'redis']).toContain(dbType);

      const prometheusRes = await request(app.getHttpServer())
        .get('/prometheus/metrics')
        .expect(200);

      expect(prometheusRes.text).toContain('betterdb_instance_info');
      // Verify instance info has version and role labels
      expect(prometheusRes.text).toMatch(/version="[\d.]+"/);
      expect(prometheusRes.text).toMatch(/role="(master|slave|sentinel)"/);
    });

    it('should handle concurrent requests across different endpoints', async () => {
      const promises = [
        request(app.getHttpServer()).get('/health').set('Connection', 'close'),
        request(app.getHttpServer()).get('/metrics/info').set('Connection', 'close'),
        request(app.getHttpServer()).get('/settings').set('Connection', 'close'),
      ];

      const responses = await Promise.all(promises);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
      });

      await waitForConnectionCleanup();
    });

    it('should maintain data consistency during rapid polling', async () => {
      const pollCount = 5;
      const pollResults: Array<{ id: string; addr: string }[]> = [];

      for (let i = 0; i < pollCount; i++) {
        const res = await request(app.getHttpServer())
          .get('/metrics/clients')
          .expect(200);

        pollResults.push(res.body);
      }

      // All polls should return valid arrays
      pollResults.forEach((result) => {
        expect(Array.isArray(result)).toBe(true);
        // Each client should have expected properties
        if (result.length > 0) {
          expect(result[0]).toHaveProperty('id');
          expect(result[0]).toHaveProperty('addr');
        }
      });
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle invalid query parameters gracefully', async () => {
      // API may return 200 with defaults or 400/500 for invalid params
      const response = await request(app.getHttpServer())
        .get('/metrics/slowlog?count=invalid');

      // Accept graceful handling - either error or default behavior
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should handle non-existent client ID gracefully', async () => {
      // API may return 200 with empty/null or 404
      const response = await request(app.getHttpServer())
        .get('/metrics/clients/99999999999');

      expect([200, 404]).toContain(response.status);
    });

    it('should ignore unknown fields in settings updates', async () => {
      const response = await request(app.getHttpServer())
        .put('/settings')
        .set('Content-Type', 'application/json')
        .send({
          invalidField: 'should be ignored',
        })
        .expect(200);

      // Should return settings without the invalid field
      expect(response.body).toHaveProperty('settings');
      expect(response.body.settings).not.toHaveProperty('invalidField');
    });

    it('should persist localRetentionDays and allow clearing it back to keep-forever', async () => {
      const set = await request(app.getHttpServer())
        .put('/settings')
        .set('Content-Type', 'application/json')
        .send({ localRetentionDays: 30 })
        .expect(200);
      expect(set.body.settings.localRetentionDays).toBe(30);

      const get = await request(app.getHttpServer()).get('/settings').expect(200);
      expect(get.body.settings.localRetentionDays).toBe(30);

      const cleared = await request(app.getHttpServer())
        .put('/settings')
        .set('Content-Type', 'application/json')
        .send({ localRetentionDays: null })
        .expect(200);
      expect(cleared.body.settings.localRetentionDays).toBeNull();
    });

    it('should reject a non-positive localRetentionDays', async () => {
      await request(app.getHttpServer())
        .put('/settings')
        .set('Content-Type', 'application/json')
        .send({ localRetentionDays: 0 })
        .expect(400);
    });
  });
});
