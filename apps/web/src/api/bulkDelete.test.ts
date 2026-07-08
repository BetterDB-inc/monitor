import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bulkDeleteApi } from './bulkDelete';
import { setCurrentConnectionId } from './client';

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('bulkDeleteApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCurrentConnectionId('conn-1');
  });

  it('POSTs the request body to the preview endpoint', async () => {
    const fetchSpy = mockFetch();
    await bulkDeleteApi.preview({ match: 'session:*', scope: 'node', count: 200 });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/bulk-delete/preview');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      match: 'session:*',
      scope: 'node',
      count: 200,
    });
    // Connection header is injected by the client.
    expect((init?.headers as Record<string, string>)['x-connection-id']).toBe('conn-1');
  });

  it('POSTs to the execute endpoint', async () => {
    const fetchSpy = mockFetch();
    await bulkDeleteApi.execute({ match: 'tmp:*', confirmDeleteAll: false });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/bulk-delete/execute');
    expect(init?.method).toBe('POST');
  });

  it('GETs a job by id', async () => {
    const fetchSpy = mockFetch();
    await bulkDeleteApi.getJob('job-123');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/bulk-delete/jobs/job-123');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('POSTs to the cancel endpoint', async () => {
    const fetchSpy = mockFetch();
    await bulkDeleteApi.cancelJob('job-123');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/bulk-delete/jobs/job-123/cancel');
    expect(init?.method).toBe('POST');
  });

  it('passes the limit query param when listing audits', async () => {
    const fetchSpy = mockFetch();
    await bulkDeleteApi.getAudits(25);

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/bulk-delete/audits?limit=25');
  });
});
