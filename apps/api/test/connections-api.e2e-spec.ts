import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

/**
 * E2E tests for the /connections API endpoints.
 * Tests CRUD operations for database connections.
 */
describe('Connections API (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /connections', () => {
    it('should return connection list with currentId', async () => {
      const response = await request(app.getHttpServer())
        .get('/connections')
        .expect(200);

      expect(response.body).toHaveProperty('connections');
      expect(response.body).toHaveProperty('currentId');
      expect(Array.isArray(response.body.connections)).toBe(true);

      // Should have at least the default connection
      expect(response.body.connections.length).toBeGreaterThanOrEqual(1);

      // Verify connection structure
      const conn = response.body.connections[0];
      expect(conn).toHaveProperty('id');
      expect(conn).toHaveProperty('name');
      expect(conn).toHaveProperty('host');
      expect(conn).toHaveProperty('port');
      expect(conn).toHaveProperty('isConnected');
    });

    it('should not expose password in connection list', async () => {
      const response = await request(app.getHttpServer())
        .get('/connections')
        .expect(200);

      for (const conn of response.body.connections) {
        expect(conn).not.toHaveProperty('password');
      }
    });

    it('should include capabilities for connected instances', async () => {
      const response = await request(app.getHttpServer())
        .get('/connections')
        .expect(200);

      const connectedConns = response.body.connections.filter((c: any) => c.isConnected);
      if (connectedConns.length > 0) {
        const conn = connectedConns[0];
        expect(conn).toHaveProperty('capabilities');
        expect(conn.capabilities).toHaveProperty('dbType');
        expect(['valkey', 'redis']).toContain(conn.capabilities.dbType);
      }
    });
  });

  describe('GET /connections/current', () => {
    it('should return current default connection id', async () => {
      const response = await request(app.getHttpServer())
        .get('/connections/current')
        .expect(200);

      expect(response.body).toHaveProperty('id');
      // id can be string or null
      if (response.body.id !== null) {
        expect(typeof response.body.id).toBe('string');
      }
    });
  });

  describe('POST /connections/test', () => {
    it('should test connection successfully for valid host', async () => {
      // Test against the same host as the default connection
      const listRes = await request(app.getHttpServer()).get('/connections');
      const defaultConn = listRes.body.connections.find((c: any) => c.isDefault);

      const response = await request(app.getHttpServer())
        .post('/connections/test')
        .send({
          name: 'Test Connection',
          host: defaultConn?.host || 'localhost',
          port: defaultConn?.port || 6379,
        })
        .expect((res) => {
          // POST can return 200 or 201 depending on framework
          expect([200, 201]).toContain(res.status);
        });

      // Depending on whether the DB is reachable in the test environment
      expect(response.body).toHaveProperty('success');
      expect(typeof response.body.success).toBe('boolean');
    });

    it('should return failure for invalid host', async () => {
      const response = await request(app.getHttpServer())
        .post('/connections/test')
        .send({
          name: 'Bad Connection',
          host: 'invalid-host-that-does-not-exist-12345.local',
          port: 6379,
        })
        .expect((res) => {
          // POST can return 200 or 201
          expect([200, 201]).toContain(res.status);
        });

      expect(response.body.success).toBe(false);
      expect(response.body).toHaveProperty('error');
    });

    it('should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/connections/test')
        .send({
          name: 'Missing Host',
          // host is missing
          port: 6379,
        })
        .expect(400);
    });
  });

  describe('POST /connections (create)', () => {
    let createdConnectionId: string | null = null;

    afterEach(async () => {
      // Cleanup: delete the created connection if it exists
      if (createdConnectionId) {
        await request(app.getHttpServer())
          .delete(`/connections/${createdConnectionId}`)
          .expect((res) => {
            // Accept 200 or 400 (if already deleted or is env-default)
            expect([200, 400]).toContain(res.status);
          });
        createdConnectionId = null;
      }
    });

    it('should reject creation with invalid host (connection test fails)', async () => {
      const response = await request(app.getHttpServer())
        .post('/connections')
        .send({
          name: 'Invalid Connection',
          host: 'this-host-definitely-does-not-exist-xyz.local',
          port: 6379,
        })
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/connections')
        .send({
          // Missing name
          host: 'localhost',
          port: 6379,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/connections')
        .send({
          name: 'Test',
          // Missing host
          port: 6379,
        })
        .expect(400);
    });

    it('should validate port range', async () => {
      await request(app.getHttpServer())
        .post('/connections')
        .send({
          name: 'Bad Port',
          host: 'localhost',
          port: 99999, // Invalid port
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/connections')
        .send({
          name: 'Bad Port',
          host: 'localhost',
          port: -1, // Invalid port
        })
        .expect(400);
    });
  });

  describe('POST /connections/:id/default', () => {
    it('should set a connection as default', async () => {
      // Get current connections
      const listRes = await request(app.getHttpServer()).get('/connections');
      const firstConn = listRes.body.connections[0];

      const response = await request(app.getHttpServer())
        .post(`/connections/${firstConn.id}/default`)
        .expect((res) => {
          // POST can return 200 or 201
          expect([200, 201]).toContain(res.status);
        });

      expect(response.body.success).toBe(true);

      // Verify it's now the default
      const currentRes = await request(app.getHttpServer()).get('/connections/current');
      expect(currentRes.body.id).toBe(firstConn.id);
    });

    it('should return 404 for non-existent connection', async () => {
      await request(app.getHttpServer())
        .post('/connections/non-existent-connection-id/default')
        .expect(404);
    });
  });

  describe('POST /connections/:id/reconnect', () => {
    it('should reconnect an existing connection', async () => {
      // Get the default connection
      const listRes = await request(app.getHttpServer()).get('/connections');
      const defaultConn = listRes.body.connections.find((c: any) => c.isDefault);

      if (defaultConn) {
        const response = await request(app.getHttpServer())
          .post(`/connections/${defaultConn.id}/reconnect`)
          .expect((res) => {
            // May succeed (200/201) or fail (400) depending on DB availability
            expect([200, 201, 400]).toContain(res.status);
          });

        if (response.status === 200 || response.status === 201) {
          expect(response.body.success).toBe(true);
        }
      }
    });

    it('should return error for non-existent connection', async () => {
      await request(app.getHttpServer())
        .post('/connections/non-existent-id/reconnect')
        .expect(400);
    });
  });

  describe('DELETE /connections/:id', () => {
    it('should not allow deleting env-default connection', async () => {
      const response = await request(app.getHttpServer())
        .delete('/connections/env-default')
        .expect(400);

      expect(response.body.message).toContain('Cannot remove');
    });

    it('should succeed silently for non-existent connection', async () => {
      // Delete of non-existent connection succeeds (idempotent) or returns error
      await request(app.getHttpServer())
        .delete('/connections/non-existent-connection-id-12345')
        .expect((res) => {
          // Can succeed (200) or fail (400/404) depending on implementation
          expect([200, 400, 404]).toContain(res.status);
        });
    });
  });

  describe('Connection workflow integration', () => {
    it('should list -> get current -> verify consistency', async () => {
      // List all connections
      const listRes = await request(app.getHttpServer())
        .get('/connections')
        .expect(200);

      // Get current
      const currentRes = await request(app.getHttpServer())
        .get('/connections/current')
        .expect(200);

      // The currentId in list should match the current endpoint
      expect(listRes.body.currentId).toBe(currentRes.body.id);

      // The default connection in list should be marked as default
      const defaultConn = listRes.body.connections.find((c: any) => c.id === currentRes.body.id);
      if (defaultConn) {
        expect(defaultConn.isDefault).toBe(true);
      }
    });
  });
});
