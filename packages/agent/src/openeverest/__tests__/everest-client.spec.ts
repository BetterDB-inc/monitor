import { EverestClient, everestApiUrl } from '../everest-client';

const REF = { cluster: 'main', namespace: 'db', instance: 'orders' };

function clientAnswering(status: number, body = '{}') {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { seen, client: new EverestClient({ baseUrl: 'http://everest.example:8080/', fetch: fetchImpl }) };
}

describe('EverestClient.checkConnectionAccess', () => {
  it('calls the connection endpoint with the forwarded Authorization header only', async () => {
    const { seen, client } = clientAnswering(200, '{"password":"never-stored"}');

    const result = await client.checkConnectionAccess(REF, 'Bearer user-jwt');

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://everest.example:8080/v1/clusters/main/namespaces/db/instances/orders/connection');
    expect(seen[0].init.method).toBe('GET');
    expect(seen[0].init.headers).toEqual({ Authorization: 'Bearer user-jwt', Accept: 'application/json' });
  });

  it('refuses on 403: the user lacks read-connection on the instance', async () => {
    const { client } = clientAnswering(403, '{"error":"insufficient permissions"}');

    const result = await client.checkConnectionAccess(REF, 'Bearer user-jwt');

    expect(result).toEqual({ ok: false, status: 403, reason: expect.stringContaining('read-connection') });
  });

  it('refuses on 401 and 404 with their own reasons', async () => {
    await expect(clientAnswering(401).client.checkConnectionAccess(REF, 'Bearer x')).resolves.toMatchObject({ ok: false, status: 401 });
    await expect(clientAnswering(404).client.checkConnectionAccess(REF, 'Bearer x')).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it('reports other answers and transport failures as a 502 from the API', async () => {
    await expect(clientAnswering(500).client.checkConnectionAccess(REF, 'Bearer x')).rejects.toMatchObject({ status: 502 });

    const failing = new EverestClient({
      baseUrl: 'http://everest.example',
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    });
    await expect(failing.checkConnectionAccess(REF, 'Bearer x')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('unreachable') });
  });

  it('escapes the instance reference in the URL', () => {
    const { client } = clientAnswering(200);
    expect(client.connectionUrl({ cluster: 'a b', namespace: 'ns', instance: 'x/y' }))
      .toBe('http://everest.example:8080/v1/clusters/a%20b/namespaces/ns/instances/x%2Fy/connection');
  });
});

describe('everestApiUrl', () => {
  it('follows the plugin template lookup order', () => {
    expect(everestApiUrl({ EVEREST_API_URL: 'http://e:1/' })).toBe('http://e:1');
    expect(everestApiUrl({ EVEREST_SERVICE_HOST: '10.1.2.3', EVEREST_SERVICE_PORT: '9090' })).toBe('http://10.1.2.3:9090');
    expect(everestApiUrl({})).toBe('http://everest.everest-system.svc.cluster.local:8080');
  });
});
