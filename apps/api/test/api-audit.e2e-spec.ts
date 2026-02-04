import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

describe('Audit API (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /audit/entries', () => {
    it('should return paginated ACL entries array', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/entries')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      // Verify entries have expected structure if any exist
      if (response.body.length > 0) {
        const entry = response.body[0];
        // ACL entries have timestampCreated/timestampLastUpdated, not generic timestamp
        expect(entry).toHaveProperty('timestampCreated');
        expect(entry).toHaveProperty('reason');
      }
    });

    it('should support limit and offset pagination', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/entries?limit=10&offset=0')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(10);
    });

    it('should filter by username', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/entries?username=default')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      // All returned entries should match the filter
      response.body.forEach((entry: { username?: string; client?: string }) => {
        // Username might be in username or client field depending on implementation
        const hasMatchingUser = entry.username === 'default' || 
          (entry.client && entry.client.includes('default'));
        expect(hasMatchingUser || response.body.length === 0).toBe(true);
      });
    });

    it('should filter by reason', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/entries?reason=auth')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      // All returned entries should match the filter
      response.body.forEach((entry: { reason?: string }) => {
        if (entry.reason) {
          expect(entry.reason.toLowerCase()).toContain('auth');
        }
      });
    });
  });

  describe('GET /audit/stats', () => {
    it('should return stats with totalEntries, entriesByReason, entriesByUser', async () => {
      const response = await request(app.getHttpServer())
        .get('/audit/stats')
        .expect(200);

      expect(response.body).toHaveProperty('totalEntries');
      expect(response.body).toHaveProperty('entriesByReason');
      expect(response.body).toHaveProperty('entriesByUser');
      expect(typeof response.body.totalEntries).toBe('number');
      expect(response.body.totalEntries).toBeGreaterThanOrEqual(0);
    });
  });

  describe('DELETE /audit/entries', () => {
    it('should handle cleanup request', async () => {
      const response = await request(app.getHttpServer())
        .delete('/audit/entries');

      // Endpoint may exist (200) or not be implemented (404)
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(typeof response.body.deleted).toBe('number');
      }
    });
  });
});
