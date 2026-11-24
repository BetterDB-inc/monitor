import { describe, expect, it } from 'vitest';
import { ApiError, instancePath, request } from './api';

const answering = (status: number, body: unknown) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetchImpl = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
};

describe('instancePath', () => {
  it('encodes the reference and uses the cluster from the plugin base path', () => {
    expect(instancePath('db', 'orders', 'status', 'main')).toBe('/api/instances/main/db/orders/status');
    expect(instancePath('db', 'a/b', 'enable', 'c d')).toBe('/api/instances/c%20d/db/a%2Fb/enable');
  });
});

describe('request', () => {
  it('returns the JSON body and sets Content-Type only when sending one', async () => {
    const { calls, fetchImpl } = answering(200, { ok: true });

    await request(fetchImpl, '/api/settings');
    await request(fetchImpl, '/api/settings', { method: 'PUT', body: '{}' });

    expect(calls[0].init?.headers).toEqual({});
    expect(calls[1].init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('surfaces the backend error message with its status', async () => {
    const { fetchImpl } = answering(403, { error: 'enabling BetterDB needs the read-connection permission on this instance' });

    await expect(request(fetchImpl, '/api/instances/main/db/x/enable', { method: 'POST' })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('read-connection'),
    } satisfies Partial<ApiError>);
  });
});
