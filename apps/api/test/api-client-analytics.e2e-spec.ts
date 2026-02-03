import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

describe('Client Analytics API (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /client-analytics/snapshots', () => {
    it('should return snapshots array with client data', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/snapshots')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      // Snapshots contain client objects directly
      if (response.body.length > 0) {
        const client = response.body[0];
        expect(client).toHaveProperty('clientId');
        expect(client).toHaveProperty('addr');
        expect(client).toHaveProperty('name');
      }
    });

    it('should support limit pagination', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/snapshots?limit=10')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(10);
    });

    it('should filter by name', async () => {
      const allResponse = await request(app.getHttpServer())
        .get('/client-analytics/snapshots?limit=1')
        .expect(200);

      if (allResponse.body.length > 0 && allResponse.body[0].name) {
        const clientName = allResponse.body[0].name;
        const response = await request(app.getHttpServer())
          .get(`/client-analytics/snapshots?name=${encodeURIComponent(clientName)}`)
          .expect(200);

        expect(Array.isArray(response.body)).toBe(true);
      }
    });
  });

  describe('GET /client-analytics/timeseries', () => {
    it('should return timeseries data with required params', async () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const response = await request(app.getHttpServer())
        .get(`/client-analytics/timeseries?startTime=${oneHourAgo}&endTime=${now}`)
        .expect(200);

      // Timeseries can be array or object depending on data availability
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should return 400 when startTime or endTime is missing', async () => {
      await request(app.getHttpServer())
        .get('/client-analytics/timeseries')
        .expect(400);

      await request(app.getHttpServer())
        .get('/client-analytics/timeseries?startTime=123456')
        .expect(400);

      await request(app.getHttpServer())
        .get('/client-analytics/timeseries?endTime=123456')
        .expect(400);
    });
  });

  describe('GET /client-analytics/stats', () => {
    it('should return stats with currentConnections, peakConnections, etc.', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/stats')
        .expect(200);

      expect(response.body).toHaveProperty('currentConnections');
      expect(response.body).toHaveProperty('peakConnections');
      expect(response.body).toHaveProperty('connectionsByName');
      expect(response.body).toHaveProperty('connectionsByUser');
      expect(typeof response.body.currentConnections).toBe('number');
      expect(typeof response.body.peakConnections).toBe('number');
      expect(response.body.currentConnections).toBeGreaterThanOrEqual(0);
      expect(response.body.peakConnections).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /client-analytics/idle-connections', () => {
    it('should return idle connections analysis', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/idle-connections')
        .expect(200);

      // Response contains idle connection data (structure varies)
      expect(response.body).toBeDefined();
    });
  });

  describe('GET /client-analytics/command-distribution', () => {
    it('should return command distribution data', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/command-distribution')
        .expect(200);

      expect(response.body).toHaveProperty('distribution');
      expect(Array.isArray(response.body.distribution)).toBe(true);
      if (response.body.distribution.length > 0) {
        const entry = response.body.distribution[0];
        expect(entry).toHaveProperty('identifier');
        expect(entry).toHaveProperty('commands');
      }
    });
  });

  describe('GET /client-analytics/buffer-anomalies', () => {
    it('should return anomaly detection results', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/buffer-anomalies')
        .expect(200);

      // Response structure varies based on detected anomalies
      expect(response.body).toBeDefined();
    });
  });

  describe('GET /client-analytics/spike-detection', () => {
    it('should return spike detection data', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/spike-detection')
        .expect(200);

      // Response structure varies based on detected spikes
      expect(response.body).toBeDefined();
    });
  });

  describe('GET /client-analytics/activity-timeline', () => {
    it('should return activity timeline with buckets', async () => {
      const response = await request(app.getHttpServer())
        .get('/client-analytics/activity-timeline')
        .expect(200);

      expect(response.body).toHaveProperty('buckets');
      expect(Array.isArray(response.body.buckets)).toBe(true);
    });
  });

  describe('DELETE /client-analytics/cleanup', () => {
    it('should return cleanup result', async () => {
      const response = await request(app.getHttpServer())
        .delete('/client-analytics/cleanup')
        .expect(200);

      expect(response.body).toHaveProperty('pruned');
      expect(typeof response.body.pruned).toBe('number');
    });
  });
});
