import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createTestApp } from './test-utils';

function mockPosthog(status: number, body: string) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    status,
    text: () => Promise.resolve(body),
    headers: { get: (k: string) => (k === 'content-type' ? 'application/json' : null) },
  } as any);
}

describe('PostHog Proxy (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /ingest/e/', () => {
    it('proxies event capture and returns upstream response', async () => {
      const fetchSpy = mockPosthog(200, '{"status":1}');

      const res = await request(app.getHttpServer())
        .post('/ingest/e/')
        .send({ event: 'pageview', distinct_id: 'user_1' })
        .expect(200);

      expect(res.body).toEqual({ status: 1 });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://eu.i.posthog.com/e/',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('forwards the request body to PostHog', async () => {
      const fetchSpy = mockPosthog(200, '{"status":1}');
      const payload = { event: 'click', distinct_id: 'user_2', properties: { btn: 'signup' } };

      await request(app.getHttpServer()).post('/ingest/e/').send(payload).expect(200);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify(payload) }),
      );
    });
  });

  describe('POST /ingest/decide', () => {
    it('proxies feature flag evaluation', async () => {
      const fetchSpy = mockPosthog(200, '{"featureFlags":{"my-flag":true}}');

      const res = await request(app.getHttpServer())
        .post('/ingest/decide')
        .send({ token: 'abc', distinct_id: 'user_1' })
        .expect(200);

      expect(res.body).toHaveProperty('featureFlags');
      expect(fetchSpy).toHaveBeenCalledWith('https://eu.i.posthog.com/decide', expect.any(Object));
    });
  });

  describe('POST /ingest/batch/', () => {
    it('proxies batch event ingestion', async () => {
      const fetchSpy = mockPosthog(200, '{"status":1}');

      await request(app.getHttpServer())
        .post('/ingest/batch/')
        .send({ batch: [{ event: 'e1', distinct_id: 'u1' }] })
        .expect(200);

      expect(fetchSpy).toHaveBeenCalledWith('https://eu.i.posthog.com/batch/', expect.any(Object));
    });
  });

  describe('error handling', () => {
    it('forwards upstream 400 status', async () => {
      mockPosthog(400, '{"error":"invalid token"}');

      await request(app.getHttpServer())
        .post('/ingest/e/')
        .send({ event: 'x' })
        .expect(400);
    });

    it('forwards upstream 503 status', async () => {
      mockPosthog(503, '{"error":"service unavailable"}');

      await request(app.getHttpServer())
        .post('/ingest/e/')
        .send({ event: 'x' })
        .expect(503);
    });
  });
});
