import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp, waitForConnectionCleanup } from './test-utils';

describe('Prometheus API (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /prometheus/metrics', () => {
    it('should return valid Prometheus exposition format with all expected metrics', async () => {
      const response = await request(app.getHttpServer())
        .get('/prometheus/metrics')
        .expect(200);

      // Content type
      expect(response.headers['content-type']).toMatch(/text\/plain/);

      // Must have HELP and TYPE comments
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');

      // Required metrics (now with connection labels)
      expect(response.text).toMatch(/betterdb_connected_clients(\{[^}]+\})?\s+\d+/);
      expect(response.text).toMatch(/betterdb_memory_used_bytes(\{[^}]+\})?\s+\d+/);
      expect(response.text).toMatch(/betterdb_client_connections_current(\{[^}]+\})?\s+\d+/);
      expect(response.text).toMatch(/betterdb_slowlog/);

      // Instance info with labels (version, role, os)
      expect(response.text).toMatch(/betterdb_instance_info\{[^}]+\}\s+1/);
      expect(response.text).toMatch(/version="[\d.]+"/);
      expect(response.text).toMatch(/role="(master|slave|sentinel)"/);

      // Validate format: metric lines should be "name{labels} value" or "name value"
      const lines = response.text.split('\n');
      const metricLines = lines.filter(
        (line) => line && !line.startsWith('#') && line.trim(),
      );

      expect(metricLines.length).toBeGreaterThan(5);
      metricLines.forEach((line) => {
        // Should match: metric_name{label="value"} 123 or metric_name 123
        // Metric names can contain letters, digits, and underscores
        expect(line).toMatch(/^[a-z_][a-z0-9_]*(\{[^}]*\})?\s+[\d.eE+-]+$/);
      });
    });

    it('should handle multiple concurrent requests', async () => {
      const promises = Array(3)
        .fill(null)
        .map(() =>
          request(app.getHttpServer())
            .get('/prometheus/metrics')
            .set('Connection', 'close')
            .expect(200),
        );

      const responses = await Promise.all(promises);

      responses.forEach((response) => {
        expect(response.text).toContain('# HELP');
        expect(response.text).toContain('betterdb_connected_clients');
      });

      await waitForConnectionCleanup();
    });
  });
});
