import { createServer, type Server } from 'http';
import type { AddressInfo, LookupFunction } from 'net';
import { pinnedRequest } from '../pinned-request';

const toLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
      { address: '127.0.0.1', family: 4 },
    ]);
    return;
  }
  callback(null, '127.0.0.1', 4);
};

describe('pinnedRequest', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/reset') {
        response.writeHead(205);
        response.end('ignored');
        return;
      }
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

  const send = (path: string, headers: Record<string, string> = {}) =>
    pinnedRequest(`http://pinned.example:${port}${path}`, { headers, signal: AbortSignal.timeout(5_000), lookup: toLoopback });

  it('connects through the given lookup and does not follow redirects', async () => {
    const ok = await send('/metrics', { Authorization: 'Bearer t' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-auth')).toBe('Bearer t');
    expect(await ok.text()).toBe('lmcache:a_total 1');
    const redirect = await send('/redirect');
    expect(redirect.status).toBe(302);
    await redirect.body?.cancel();
  });

  it('returns a null body for 205', async () => {
    const reset = await send('/reset');
    expect(reset.status).toBe(205);
    expect(reset.body).toBeNull();
  });
});
