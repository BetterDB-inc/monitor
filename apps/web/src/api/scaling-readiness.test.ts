import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scalingReadinessApi } from './scaling-readiness';
import { setCurrentConnectionId } from './client';

describe('scalingReadinessApi.updateSettings', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    setCurrentConnectionId(null);
    vi.unstubAllGlobals();
  });

  it('sends the explicit connection id instead of the current one', async () => {
    setCurrentConnectionId('current');
    await scalingReadinessApi.updateSettings({ alertThreshold: 55 }, 'edited');
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['x-connection-id']).toBe('edited');
    expect(init.method).toBe('PUT');
  });
});
