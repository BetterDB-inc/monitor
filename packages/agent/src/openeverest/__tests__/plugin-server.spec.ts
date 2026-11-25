import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createPluginServer, HttpError, InstanceView, PluginBackend, SettingsView } from '../plugin-server';
import { EverestClient, InstanceRef } from '../everest-client';

// Exercises the HTTP routes with a backend whose enable() runs the real
// EverestClient authorization check against a fake OpenEverest API, so the
// 403 path is covered end to end: proxy header in, refusal out, nothing stored.

const OFF: InstanceView['status'] = { state: 'off', secretName: null, tls: false, nodes: [] };

class FakeBackend implements PluginBackend {
  enabled = new Set<string>();
  settingsState: SettingsView = { url: '', tokenSet: false, dashboardUrl: null, source: 'none' };

  constructor(private readonly everest: EverestClient) {}

  async enable(ref: InstanceRef, authorization: string): Promise<InstanceView> {
    const check = await this.everest.checkConnectionAccess(ref, authorization);
    if (!check.ok) throw new HttpError(check.status, check.reason);
    this.enabled.add(`${ref.cluster}/${ref.namespace}/${ref.instance}`);
    return this.status(ref);
  }

  async disable(ref: InstanceRef, authorization: string): Promise<InstanceView> {
    const check = await this.everest.checkConnectionAccess(ref, authorization);
    if (!check.ok) throw new HttpError(check.status, check.reason);
    this.enabled.delete(`${ref.cluster}/${ref.namespace}/${ref.instance}`);
    return this.status(ref);
  }

  status(ref: InstanceRef): InstanceView {
    const enabled = this.enabled.has(`${ref.cluster}/${ref.namespace}/${ref.instance}`);
    return { ref, enabled, status: enabled ? { ...OFF, state: 'connecting' } : OFF, dashboardUrl: null };
  }

  settings(): SettingsView {
    return this.settingsState;
  }

}

describe('plugin server', () => {
  let server: Server;
  let base: string;
  let backend: FakeBackend;
  let readyNow = true;
  let everestStatus = 200;
  const everestCalls: Array<{ url: string; authorization: string | undefined }> = [];

  beforeAll(async () => {
    const everest = new EverestClient({
      baseUrl: 'http://everest.test',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        everestCalls.push({ url: String(url), authorization: (init?.headers as Record<string, string>)?.Authorization });
        return new Response('{}', { status: everestStatus });
      }) as typeof fetch,
    });
    backend = new FakeBackend(everest);
    server = createPluginServer({ backend, uiDir: '/nonexistent', log: () => undefined, ready: () => readyNow });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    everestStatus = 200;
    everestCalls.length = 0;
    backend.enabled.clear();
  });

  it('answers the probes and reports a missing bundle', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/main.js`)).status).toBe(404);
  });

  it('is live before it is ready, and ready once the manager has started', async () => {
    readyNow = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const notReady = await fetch(`${base}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ ready: false });

    readyNow = true;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('enables an instance after OpenEverest accepts the forwarded token', async () => {
    const res = await fetch(`${base}/api/instances/main/db/orders/enable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, status: { state: 'connecting' } });
    expect(everestCalls).toEqual([{
      url: 'http://everest.test/v1/clusters/main/namespaces/db/instances/orders/connection',
      authorization: 'Bearer user-jwt',
    }]);
  });

  it('refuses to enable with 403 when the user lacks read-connection, and stores nothing', async () => {
    everestStatus = 403;

    const res = await fetch(`${base}/api/instances/main/db/orders/enable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('read-connection') });
    expect(backend.enabled.size).toBe(0);
    const status = await (await fetch(`${base}/api/instances/main/db/orders/status`)).json();
    expect(status).toMatchObject({ enabled: false, status: { state: 'off' } });
  });

  it('rejects enable and disable without an Authorization header before calling OpenEverest', async () => {
    for (const action of ['enable', 'disable']) {
      const res = await fetch(`${base}/api/instances/main/db/orders/${action}`, { method: 'POST' });
      expect(res.status).toBe(401);
    }
    expect(everestCalls).toHaveLength(0);
  });

  it('runs the same check for disable', async () => {
    backend.enabled.add('main/db/orders');
    everestStatus = 403;

    const res = await fetch(`${base}/api/instances/main/db/orders/disable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt' },
    });

    expect(res.status).toBe(403);
    expect(backend.enabled.has('main/db/orders')).toBe(true);
  });

  it('rejects references that are not Kubernetes names', async () => {
    const res = await fetch(`${base}/api/instances/main/Not_A_Namespace/orders/status`);
    expect(res.status).toBe(400);
  });

  it('answers 400 to a malformed percent-encoding instead of 500', async () => {
    const res = await fetch(`${base}/api/instances/main/db/%E0%A4%A/status`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('URI') });
  });

  it('passes the OpenEverest client\'s own status through when the API is unreachable', async () => {
    everestStatus = 503;

    const res = await fetch(`${base}/api/instances/main/db/orders/enable`, {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt' },
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: expect.stringContaining('503') });
  });

  it('serves settings on GET and has no way to change them', async () => {
    expect(await (await fetch(`${base}/api/settings`)).json()).toEqual(backend.settingsState);

    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/settings`, {
        method,
        headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'wss://attacker.example/agent/ws', token: 'x' }),
      });
      expect(res.status).toBe(405);
    }
    expect(everestCalls).toHaveLength(0);
  });
});
