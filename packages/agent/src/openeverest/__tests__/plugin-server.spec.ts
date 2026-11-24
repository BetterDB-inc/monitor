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
  updates: Array<{ url?: string; token?: string }> = [];

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

  async updateSettings(input: { url?: string; token?: string }): Promise<SettingsView> {
    this.updates.push(input);
    return this.settingsState;
  }
}

describe('plugin server', () => {
  let server: Server;
  let base: string;
  let backend: FakeBackend;
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
    server = createPluginServer({ backend, uiDir: '/nonexistent', log: () => undefined });
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
    backend.updates.length = 0;
  });

  it('answers the probes and reports a missing bundle', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/main.js`)).status).toBe(404);
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

  it('serves settings on GET and writes them on an authenticated PUT', async () => {
    expect(await (await fetch(`${base}/api/settings`)).json()).toEqual(backend.settingsState);

    const unauthenticated = await fetch(`${base}/api/settings`, { method: 'PUT', body: '{}' });
    expect(unauthenticated.status).toBe(401);

    const bad = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://not-a-websocket' }),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'wss://acme.app.betterdb.com/agent/ws', token: ' tok ' }),
    });
    expect(ok.status).toBe(200);
    expect(backend.updates).toEqual([{ url: 'wss://acme.app.betterdb.com/agent/ws', token: 'tok' }]);
  });
});
