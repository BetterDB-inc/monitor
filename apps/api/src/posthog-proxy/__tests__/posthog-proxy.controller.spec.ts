import { PosthogProxyController } from '../posthog-proxy.controller';

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com';

function makeReply() {
  const reply = {
    status: jest.fn(),
    header: jest.fn(),
    send: jest.fn(),
  };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  return reply;
}

function makeReq(overrides: Partial<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = {}) {
  return {
    method: 'POST',
    url: '/ingest/e/',
    headers: { 'content-type': 'application/json' },
    body: { event: 'pageview', distinct_id: 'user_1' },
    ...overrides,
  } as any;
}

function mockFetchResponse(status: number, body: string, contentType = 'application/json') {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    status,
    text: () => Promise.resolve(body),
    headers: { get: (k: string) => (k === 'content-type' ? contentType : null) },
  } as any);
}

describe('PosthogProxyController', () => {
  let controller: PosthogProxyController;

  beforeEach(() => {
    controller = new PosthogProxyController();
    jest.restoreAllMocks();
  });

  describe('URL routing', () => {
    it('forwards /ingest/e/ → {POSTHOG_HOST}/e/', async () => {
      const fetchSpy = mockFetchResponse(200, '{"status":1}');
      await controller.proxy(makeReq({ url: '/ingest/e/' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(`${POSTHOG_HOST}/e/`, expect.any(Object));
    });

    it('forwards /ingest/decide → {POSTHOG_HOST}/decide', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(makeReq({ url: '/ingest/decide', method: 'POST' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(`${POSTHOG_HOST}/decide`, expect.any(Object));
    });

    it('strips /api/ingest prefix in production', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(makeReq({ url: '/api/ingest/batch/', method: 'POST' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(`${POSTHOG_HOST}/batch/`, expect.any(Object));
    });

    it('preserves query strings', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(makeReq({ url: '/ingest/decide?v=1&token=abc', method: 'POST' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(`${POSTHOG_HOST}/decide?v=1&token=abc`, expect.any(Object));
    });
  });

  describe('request forwarding', () => {
    it('forwards POST body as JSON', async () => {
      const fetchSpy = mockFetchResponse(200, '{"status":1}');
      const body = { event: 'click', distinct_id: 'u1' };
      await controller.proxy(makeReq({ body, method: 'POST' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
      );
    });

    it('sends no body for GET requests', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(makeReq({ method: 'GET', url: '/ingest/flags/' }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: undefined }),
      );
    });

    it('forwards content-type header', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(
        makeReq({ headers: { 'content-type': 'application/json; charset=utf-8' } }),
        makeReply() as any,
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
        }),
      );
    });

    it('defaults content-type to application/json when absent', async () => {
      const fetchSpy = mockFetchResponse(200, '{}');
      await controller.proxy(makeReq({ headers: {} }), makeReply() as any);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'content-type': 'application/json' }),
        }),
      );
    });
  });

  describe('response forwarding', () => {
    it('returns the upstream status code', async () => {
      mockFetchResponse(200, '{"status":1}');
      const reply = makeReply();
      await controller.proxy(makeReq(), reply as any);
      expect(reply.status).toHaveBeenCalledWith(200);
    });

    it('forwards upstream error status codes', async () => {
      mockFetchResponse(400, '{"error":"bad request"}');
      const reply = makeReply();
      await controller.proxy(makeReq(), reply as any);
      expect(reply.status).toHaveBeenCalledWith(400);
    });

    it('forwards the upstream response body', async () => {
      mockFetchResponse(200, '{"status":1}');
      const reply = makeReply();
      await controller.proxy(makeReq(), reply as any);
      expect(reply.send).toHaveBeenCalledWith('{"status":1}');
    });

    it('forwards the upstream content-type header', async () => {
      mockFetchResponse(200, '{"status":1}', 'application/json; charset=utf-8');
      const reply = makeReply();
      await controller.proxy(makeReq(), reply as any);
      expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json; charset=utf-8');
    });

    it('defaults content-type to application/json when upstream omits it', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve('{}'),
        headers: { get: () => null },
      } as any);
      const reply = makeReply();
      await controller.proxy(makeReq(), reply as any);
      expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
    });
  });
});
