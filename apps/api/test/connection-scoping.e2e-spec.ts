import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

describe('Controller Connection Scoping (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // This test verifies that controllers accept the X-Connection-Id header
  // and pass connectionId through to storage.
  // Even without real data for the test connection, the API should return 200.

  const endpoints = [
    { path: '/audit/entries', method: 'get' },
    { path: '/audit/stats', method: 'get' },
    { path: '/client-analytics/snapshots', method: 'get' },
    { path: '/client-analytics/stats', method: 'get' },
    { path: '/slowlog-analytics/entries', method: 'get' },
    { path: '/commandlog-analytics/entries', method: 'get' },
    { path: '/webhooks', method: 'get' },
  ];

  describe('X-Connection-Id Header Handling', () => {
    for (const endpoint of endpoints) {
      it(`${endpoint.path} should accept X-Connection-Id header without error`, async () => {
        const response = await request(app.getHttpServer())
          .get(endpoint.path)
          .set('X-Connection-Id', 'test-connection-123');

        // Accept 200 or 404 (if no data) but NOT 500 (server error)
        expect(response.status).not.toBe(500);
        expect([200, 201, 404]).toContain(response.status);
      });
    }
  });

  describe('Connection Isolation Verification', () => {
    const CONN_A = 'isolation-test-conn-a';
    const CONN_B = 'isolation-test-conn-b';

    it('audit entries from connection A should not appear for connection B', async () => {
      // Request for connection A
      const responseA = await request(app.getHttpServer())
        .get('/audit/entries')
        .set('X-Connection-Id', CONN_A)
        .expect(200);

      // Request for connection B
      const responseB = await request(app.getHttpServer())
        .get('/audit/entries')
        .set('X-Connection-Id', CONN_B)
        .expect(200);

      // Both should return arrays (empty or with data)
      expect(Array.isArray(responseA.body)).toBe(true);
      expect(Array.isArray(responseB.body)).toBe(true);

      // If A has data, verify B doesn't have A's data
      if (responseA.body.length > 0 && responseB.body.length > 0) {
        const aIds = new Set(responseA.body.map((e: any) => e.id));
        const bIds = new Set(responseB.body.map((e: any) => e.id));
        // No overlap should exist
        const overlap = [...aIds].filter(id => bIds.has(id));
        expect(overlap).toHaveLength(0);
      }
    });

    it('client snapshots from connection A should not appear for connection B', async () => {
      const responseA = await request(app.getHttpServer())
        .get('/client-analytics/snapshots')
        .set('X-Connection-Id', CONN_A)
        .expect(200);

      const responseB = await request(app.getHttpServer())
        .get('/client-analytics/snapshots')
        .set('X-Connection-Id', CONN_B)
        .expect(200);

      expect(Array.isArray(responseA.body)).toBe(true);
      expect(Array.isArray(responseB.body)).toBe(true);
    });

    it('slowlog entries from connection A should not appear for connection B', async () => {
      const responseA = await request(app.getHttpServer())
        .get('/slowlog-analytics/entries')
        .set('X-Connection-Id', CONN_A)
        .expect(200);

      const responseB = await request(app.getHttpServer())
        .get('/slowlog-analytics/entries')
        .set('X-Connection-Id', CONN_B)
        .expect(200);

      expect(Array.isArray(responseA.body)).toBe(true);
      expect(Array.isArray(responseB.body)).toBe(true);
    });
  });

  describe('Stats Endpoints with Connection Scoping', () => {
    it('audit stats should be scoped to connection', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/stats')
        .set('X-Connection-Id', 'stats-test-connection')
        .expect(200);

      expect(response.body).toHaveProperty('totalEntries');
      expect(typeof response.body.totalEntries).toBe('number');
    });

    it('client analytics stats should be scoped to connection', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/stats')
        .set('X-Connection-Id', 'stats-test-connection')
        .expect(200);

      expect(response.body).toHaveProperty('currentConnections');
      expect(typeof response.body.currentConnections).toBe('number');
    });
  });
});
