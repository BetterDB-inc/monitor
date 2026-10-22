import { BadRequestException, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import { createServer as createTcpServer, type AddressInfo } from 'net';
import { assertSafeOutboundUrl, BlockedAddressError } from '@app/common/utils/outbound-url-guard';
import { fetchMetricsText, scrapeAllowsPrivateNetworks, ScrapeError } from '../metrics-fetch';

jest.mock('@app/common/utils/outbound-url-guard', () => ({
  ...jest.requireActual('@app/common/utils/outbound-url-guard'),
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

  it('surfaces a connect-time blocked address', async () => {
    const blocked = jest.fn().mockRejectedValue(new BlockedAddressError('Metrics URL resolves to a blocked address'));
    await expect(fetchMetricsText('http://x', null, blocked)).rejects.toThrow(new ScrapeError('Metrics URL resolves to a blocked address'));
  });

  it('reports a DNS failure', async () => {
    const missing = jest.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }));
    await expect(fetchMetricsText('http://x', null, missing)).rejects.toThrow(new ScrapeError('DNS lookup failed (ENOTFOUND)'));
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

  it('leaves DNS checks to connect time so the scrape timeout covers them', async () => {
    await fetchMetricsText('http://x/metrics', null, jest.fn().mockResolvedValue(respond()));
    expect(assertSafeOutboundUrl).toHaveBeenLastCalledWith('http://x/metrics', expect.objectContaining({ resolveDns: 'never' }));
  });

  it('surfaces the guard reason', async () => {
    (assertSafeOutboundUrl as jest.Mock).mockRejectedValue(new BadRequestException('Failed to resolve metrics URL hostname'));
    await expect(fetchMetricsText('http://x', null, jest.fn())).rejects.toThrow(new ScrapeError('Failed to resolve metrics URL hostname'));
  });

  describe('default transport', () => {
    let server: Server;
    let port: number;
    let seen: IncomingHttpHeaders | null;

    beforeAll(async () => {
      server = createServer((req, res) => {
        seen = req.headers;
        res.setHeader('content-type', 'text/plain');
        res.end('lmcache:a_total 1');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    beforeEach(() => {
      seen = null;
    });

    afterEach(() => jest.restoreAllMocks());

    it('connects to the validated address and keeps the original Host header', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
      await expect(fetchMetricsText(`http://vllm.internal:${port}/metrics`, 'Bearer t')).resolves.toBe('lmcache:a_total 1');
      expect(seen?.host).toBe(`vllm.internal:${port}`);
      expect(seen?.authorization).toBe('Bearer t');
    });

    it('refuses to connect when the hostname re-resolves to a blocked address', async () => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
      await expect(fetchMetricsText(`http://vllm.internal:${port}/metrics`, 'Bearer t')).rejects.toThrow(
        new ScrapeError('Metrics URL resolves to a blocked address'),
      );
      expect(seen).toBeNull();
    });

    it('reports a DNS failure', async () => {
      jest.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND vllm.internal'), { code: 'ENOTFOUND' }));
      await expect(fetchMetricsText(`http://vllm.internal:${port}/metrics`, null)).rejects.toThrow(new ScrapeError('DNS lookup failed (ENOTFOUND)'));
    });
  });

  describe('out-of-range status', () => {
    const rawServer = (statusLine: string) =>
      new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        const server = createTcpServer((socket) => {
          socket.once('data', () => socket.end(`${statusLine}\r\nContent-Length: 0\r\n\r\n`));
        });
        server.listen(0, '127.0.0.1', () =>
          resolve({
            port: (server.address() as AddressInfo).port,
            close: () => new Promise<void>((done) => server.close(() => done())),
          }),
        );
      });

    afterEach(() => jest.restoreAllMocks());

    it.each(['HTTP/1.1 600 X', 'HTTP/1.1 101 Switching Protocols', 'HTTP/1.1 199 X'])('rejects %s as a scrape error', async (statusLine) => {
      jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
      const target = await rawServer(statusLine);
      const uncaught = jest.fn();
      process.on('uncaughtException', uncaught);
      try {
        const error = await fetchMetricsText(`http://vllm.internal:${target.port}/metrics`, null).catch((e) => e);
        await new Promise((resolve) => setImmediate(resolve));
        expect(error).toBeInstanceOf(ScrapeError);
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        process.off('uncaughtException', uncaught);
        await target.close();
      }
    });
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

describe('scrapeAllowsPrivateNetworks', () => {
  const saved = { cloud: process.env.CLOUD_MODE, block: process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE };
  afterEach(() => {
    for (const [key, value] of [['CLOUD_MODE', saved.cloud], ['KV_CACHE_SCRAPE_BLOCK_PRIVATE', saved.block]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('allows private targets on self-hosted unless the flag blocks them', () => {
    delete process.env.CLOUD_MODE;
    delete process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE;
    expect(scrapeAllowsPrivateNetworks()).toBe(true);
    process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE = 'true';
    expect(scrapeAllowsPrivateNetworks()).toBe(false);
  });

  it('blocks on padded or alternative truthy spellings of the flag', () => {
    delete process.env.CLOUD_MODE;
    for (const flag of ['true\n', ' true ', 'TRUE', '1', 'yes', 'on']) {
      process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE = flag;
      expect(scrapeAllowsPrivateNetworks()).toBe(false);
    }
  });

  it('allows private targets for explicit falsy spellings of the flag', () => {
    delete process.env.CLOUD_MODE;
    for (const flag of ['', 'false', ' FALSE\n', '0', 'no', 'off']) {
      process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE = flag;
      expect(scrapeAllowsPrivateNetworks()).toBe(true);
    }
  });

  it('fails closed and warns once when the flag value is not recognised', () => {
    delete process.env.CLOUD_MODE;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE = 'ture';
    expect(scrapeAllowsPrivateNetworks()).toBe(false);
    expect(scrapeAllowsPrivateNetworks()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('KV_CACHE_SCRAPE_BLOCK_PRIVATE');
    warn.mockRestore();
  });

  it('always blocks private targets in cloud mode', () => {
    process.env.CLOUD_MODE = 'true';
    for (const flag of [undefined, 'false', 'true']) {
      if (flag === undefined) delete process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE;
      else process.env.KV_CACHE_SCRAPE_BLOCK_PRIVATE = flag;
      expect(scrapeAllowsPrivateNetworks()).toBe(false);
    }
  });
});
