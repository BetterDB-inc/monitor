import { assertSafeOutboundUrl } from '@app/common/utils/outbound-url-guard';
import { fetchMetricsText, ScrapeError } from '../metrics-fetch';

jest.mock('@app/common/utils/outbound-url-guard', () => ({
  assertSafeOutboundUrl: jest.fn().mockResolvedValue(new URL('http://x')),
}));

const respond = (init: { status?: number; body?: string; headers?: Record<string, string> } = {}) =>
  new Response(init.body ?? '', { status: init.status ?? 200, headers: init.headers });

describe('fetchMetricsText', () => {
  beforeEach(() => {
    (assertSafeOutboundUrl as jest.Mock).mockResolvedValue(new URL('http://x'));
  });

  it('returns the body for a 200', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(respond({ body: 'lmcache:a_total 1' }));
    await expect(fetchMetricsText('http://x/metrics', null, fetchImpl)).resolves.toBe('lmcache:a_total 1');
  });

  it('sends Authorization only when given', async () => {
    const fetchImpl = jest.fn().mockImplementation(async () => respond());
    await fetchMetricsText('http://x/metrics', null, fetchImpl);
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    await fetchMetricsText('http://x/metrics', 'Bearer t', fetchImpl);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer t');
  });

  it('reports HTTP errors and redirects', async () => {
    await expect(fetchMetricsText('http://x', null, jest.fn().mockResolvedValue(respond({ status: 401 })))).rejects.toThrow('HTTP 401');
    await expect(fetchMetricsText('http://x', null, jest.fn().mockResolvedValue(respond({ status: 302 })))).rejects.toThrow(
      'redirect not followed (HTTP 302)',
    );
  });

  it('cancels the body of a rejected response', async () => {
    for (const init of [{ status: 500 }, { status: 302 }, { headers: { 'content-length': '6000000' } }]) {
      const response = respond({ ...init, body: 'x' });
      const cancel = jest.spyOn(response.body as ReadableStream, 'cancel');
      await expect(fetchMetricsText('http://x', null, jest.fn().mockResolvedValue(response))).rejects.toBeInstanceOf(ScrapeError);
      expect(cancel).toHaveBeenCalled();
    }
  });

  it('maps fetch failures to timeout and connection failed', async () => {
    const timeout = jest.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(fetchMetricsText('http://x', null, timeout)).rejects.toThrow('timeout');
    const refused = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchMetricsText('http://x', null, refused)).rejects.toThrow('connection failed');
  });

  it('rejects oversized responses by header and by stream', async () => {
    const header = jest.fn().mockResolvedValue(respond({ headers: { 'content-length': '6000000' } }));
    await expect(fetchMetricsText('http://x', null, header)).rejects.toThrow('response too large');
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const streamed = jest.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(fetchMetricsText('http://x', null, streamed)).rejects.toThrow('response too large');
  });

  it('maps a body that never ends to timeout when the signal aborts', async () => {
    const controller = new AbortController();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchImpl = jest.fn().mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      const stream = new ReadableStream({
        start(streamController) {
          init.signal.addEventListener('abort', () => streamController.error(Object.assign(new Error('t'), { name: 'TimeoutError' })));
        },
      });
      setTimeout(() => controller.abort(), 10);
      return new Response(stream, { status: 200 });
    });
    try {
      await expect(fetchMetricsText('http://x', null, fetchImpl)).rejects.toThrow('timeout');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('blocks addresses the guard rejects', async () => {
    (assertSafeOutboundUrl as jest.Mock).mockRejectedValue(new Error('nope'));
    const fetchImpl = jest.fn();
    const error = await fetchMetricsText('http://x', null, fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(ScrapeError);
    expect(error.message).toBe('blocked address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
