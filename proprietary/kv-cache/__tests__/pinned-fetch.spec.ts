import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { BlockedAddressError, guardedLookup, pinnedFetch } from '../pinned-fetch';

const resolver = (addresses: Array<{ address: string; family: number }>) =>
  jest.fn((_host: string, _options: unknown, callback: (error: null, addresses: Array<{ address: string; family: number }>) => void) =>
    callback(null, addresses),
  );

const lookupOnce = (lookup: ReturnType<typeof guardedLookup>, host: string, all = false) =>
  new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup(host, { all } as any, (error, address, family) => resolve({ error, address, family })),
  );

describe('guardedLookup', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('returns a public address in single and all modes', async () => {
    const lookup = guardedLookup(false, resolver([{ address: '8.8.8.8', family: 4 }]));
    expect(await lookupOnce(lookup, 'example.com')).toEqual({ error: null, address: '8.8.8.8', family: 4 });
    expect((await lookupOnce(lookup, 'example.com', true)).address).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('refuses a host when any answer is blocked', async () => {
    const lookup = guardedLookup(true, resolver([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]));
    expect((await lookupOnce(lookup, 'rebind.example')).error).toBeInstanceOf(BlockedAddressError);
  });

  it('applies the private network setting', async () => {
    const answers = [{ address: '10.0.0.5', family: 4 }];
    expect((await lookupOnce(guardedLookup(false, resolver(answers)), 'vllm.internal')).error).toBeInstanceOf(BlockedAddressError);
    expect((await lookupOnce(guardedLookup(true, resolver(answers)), 'vllm.internal')).address).toBe('10.0.0.5');
  });

  it('allows localhost outside production only', async () => {
    const answers = [{ address: '127.0.0.1', family: 4 }];
    process.env.NODE_ENV = 'development';
    expect((await lookupOnce(guardedLookup(true, resolver(answers)), 'localhost')).address).toBe('127.0.0.1');
    expect((await lookupOnce(guardedLookup(true, resolver(answers)), 'evil.example')).error).toBeInstanceOf(BlockedAddressError);
    process.env.NODE_ENV = 'production';
    expect((await lookupOnce(guardedLookup(true, resolver(answers)), 'localhost')).error).toBeInstanceOf(BlockedAddressError);
  });
});

describe('pinnedFetch', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/metrics' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain', 'x-auth': request.headers.authorization ?? '' });
      response.end('lmcache:a_total 1');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('fetches through the validated address and does not follow redirects', async () => {
    const fetchImpl = pinnedFetch(true, resolver([{ address: '127.0.0.1', family: 4 }]));
    const ok = await fetchImpl(`http://localhost:${port}/metrics`, { headers: { Authorization: 'Bearer t' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-auth')).toBe('Bearer t');
    expect(await ok.text()).toBe('lmcache:a_total 1');
    const redirect = await fetchImpl(`http://localhost:${port}/redirect`);
    expect(redirect.status).toBe(302);
    await redirect.body?.cancel();
  });

  it('rejects when the host resolves to a blocked address at connect time', async () => {
    const fetchImpl = pinnedFetch(true, resolver([{ address: '169.254.169.254', family: 4 }]));
    await expect(fetchImpl(`http://metadata.example:${port}/`)).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
