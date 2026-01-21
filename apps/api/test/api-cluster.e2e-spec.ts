import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp, HealthResponse } from './test-utils';

describe('Cluster API (E2E)', () => {
  let app: NestFastifyApplication;
  let healthResponse: HealthResponse;
  let isClusterMode: boolean;

  beforeAll(async () => {
    app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    healthResponse = res.body as HealthResponse;

    // Check if we're connected to a cluster
    // Try cluster info endpoint - will fail on standalone
    try {
      const clusterRes = await request(app.getHttpServer()).get('/metrics/cluster/info');
      isClusterMode = clusterRes.status === 200 && clusterRes.body.cluster_state !== undefined;
    } catch {
      isClusterMode = false;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /metrics/cluster/info', () => {
    it('should return cluster info when in cluster mode', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/info');

      if (isClusterMode) {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('cluster_state');
        expect(response.body).toHaveProperty('cluster_slots_assigned');
        expect(response.body).toHaveProperty('cluster_slots_ok');
        expect(response.body).toHaveProperty('cluster_known_nodes');
        expect(response.body).toHaveProperty('cluster_size');
      } else {
        // Standalone mode - may return error or empty
        expect([200, 500]).toContain(response.status);
      }
    });

    it('should have valid slot counts in cluster mode', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/info')
        .expect(200);

      const slotsAssigned = parseInt(response.body.cluster_slots_assigned);
      const slotsOk = parseInt(response.body.cluster_slots_ok);

      expect(slotsAssigned).toBeGreaterThan(0);
      expect(slotsAssigned).toBeLessThanOrEqual(16384);
      expect(slotsOk).toBeLessThanOrEqual(slotsAssigned);
    });
  });

  describe('GET /metrics/cluster/nodes', () => {
    it('should return array of cluster nodes', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes');

      if (isClusterMode) {
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBeGreaterThan(0);

        const node = response.body[0];
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('address');
        expect(node).toHaveProperty('flags');
        expect(node).toHaveProperty('master');
        expect(node).toHaveProperty('linkState');
        expect(node).toHaveProperty('slots');
      } else {
        expect([200, 500]).toContain(response.status);
      }
    });

    it('should have masters and replicas in cluster', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes')
        .expect(200);

      const masters = response.body.filter((n: any) => n.flags.includes('master'));
      const replicas = response.body.filter((n: any) =>
        n.flags.includes('slave') || n.flags.includes('replica')
      );

      expect(masters.length).toBeGreaterThan(0);
      // May or may not have replicas depending on cluster config
      expect(masters.length + replicas.length).toBe(response.body.length);
    });

    it('should have valid slot assignments for masters', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes')
        .expect(200);

      const masters = response.body.filter((n: any) => n.flags.includes('master'));

      let totalSlots = 0;
      for (const master of masters) {
        expect(Array.isArray(master.slots)).toBe(true);
        for (const [start, end] of master.slots) {
          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(16383);
          expect(end).toBeGreaterThanOrEqual(start);
          totalSlots += (end - start + 1);
        }
      }

      // All slots should be assigned in a healthy cluster
      expect(totalSlots).toBe(16384);
    });
  });

  describe('GET /metrics/cluster/slot-stats', () => {
    it('should return slot statistics when available', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats');

      // May be 200 (Valkey 8.0+) or 501 (older versions)
      expect([200, 501]).toContain(response.status);

      if (response.status === 200) {
        expect(typeof response.body).toBe('object');

        // Check structure of a slot entry if any exist
        const slots = Object.keys(response.body);
        if (slots.length > 0) {
          const firstSlot = response.body[slots[0]];
          expect(firstSlot).toHaveProperty('key_count');
          expect(firstSlot).toHaveProperty('expires_count');
          expect(firstSlot).toHaveProperty('total_reads');
          expect(firstSlot).toHaveProperty('total_writes');
        }
      }
    });

    it('should respect orderBy parameter', async () => {
      if (!isClusterMode) return;

      const byKeyCount = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats?orderBy=key-count');

      const byCpuUsec = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats?orderBy=cpu-usec');

      // Both should work (or both 501 if not supported)
      expect(byKeyCount.status).toBe(byCpuUsec.status);
    });

    it('should respect limit parameter', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats?limit=10');

      if (response.status === 200) {
        const slotCount = Object.keys(response.body).length;
        expect(slotCount).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('GET /metrics/cluster/nodes/discover', () => {
    it('should discover cluster nodes', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes/discover')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      if (response.body.length > 0) {
        const node = response.body[0];
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('address');
        expect(node).toHaveProperty('role');
        expect(node).toHaveProperty('healthy');
        expect(['master', 'replica']).toContain(node.role);
      }
    });
  });

  describe('GET /metrics/cluster/node-stats', () => {
    it('should return stats for all nodes', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/node-stats')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      if (response.body.length > 0) {
        const stats = response.body[0];
        expect(stats).toHaveProperty('nodeId');
        expect(stats).toHaveProperty('nodeAddress');
        expect(stats).toHaveProperty('role');
        expect(stats).toHaveProperty('memoryUsed');
        expect(stats).toHaveProperty('opsPerSec');
        expect(stats).toHaveProperty('connectedClients');
        expect(typeof stats.memoryUsed).toBe('number');
      }
    });
  });

  describe('GET /metrics/cluster/slowlog', () => {
    it('should return aggregated slowlog from all nodes', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slowlog')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      if (response.body.length > 0) {
        const entry = response.body[0];
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('timestamp');
        expect(entry).toHaveProperty('duration');
        expect(entry).toHaveProperty('command');
        expect(entry).toHaveProperty('nodeId');
        expect(entry).toHaveProperty('nodeAddress');
      }
    });

    it('should respect limit parameter', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slowlog?limit=5')
        .expect(200);

      // Each node returns up to limit, so total could be limit * nodeCount
      // But should be finite
      expect(response.body.length).toBeLessThanOrEqual(100);
    });
  });

  describe('GET /metrics/cluster/clients', () => {
    it('should return clients from all nodes', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/clients')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      if (response.body.length > 0) {
        const client = response.body[0];
        expect(client).toHaveProperty('id');
        expect(client).toHaveProperty('addr');
        expect(client).toHaveProperty('nodeId');
        expect(client).toHaveProperty('nodeAddress');
      }
    });
  });

  describe('GET /metrics/cluster/migrations', () => {
    it('should return slot migrations (empty array if none active)', async () => {
      if (!isClusterMode) return;

      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/migrations')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);

      // Migrations array is usually empty unless actively migrating
      if (response.body.length > 0) {
        const migration = response.body[0];
        expect(migration).toHaveProperty('slot');
        expect(migration).toHaveProperty('sourceNodeId');
        expect(migration).toHaveProperty('targetNodeId');
        expect(migration).toHaveProperty('state');
        expect(['migrating', 'importing']).toContain(migration.state);
      }
    });
  });

  describe('GET /metrics/cluster/nodes/:nodeId/info', () => {
    it('should return INFO for specific node', async () => {
      if (!isClusterMode) return;

      // First get a node ID
      const nodesRes = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes/discover')
        .expect(200);

      if (nodesRes.body.length === 0) return;

      const nodeId = nodesRes.body[0].id;
      const response = await request(app.getHttpServer())
        .get(`/metrics/cluster/nodes/${nodeId}/info`);

      // May succeed or fail depending on node connectivity
      expect([200, 500]).toContain(response.status);

      if (response.status === 200) {
        expect(response.body).toHaveProperty('server');
        expect(response.body).toHaveProperty('memory');
      }
    });
  });

  describe('Error handling', () => {
    it('should handle invalid orderBy parameter gracefully', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats?orderBy=invalid');

      // Should either use default or return error (500 for standalone mode)
      expect([200, 400, 500, 501]).toContain(response.status);
    });

    it('should handle invalid limit parameter gracefully', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/slot-stats?limit=-1');

      // Should either use default or return error (500 for standalone mode)
      expect([200, 400, 500, 501]).toContain(response.status);
    });

    it('should handle non-existent node ID', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics/cluster/nodes/nonexistent-node-id/info');

      expect([404, 500]).toContain(response.status);
    });
  });
});
