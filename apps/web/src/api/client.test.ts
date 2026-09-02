import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchApi,
  PaymentRequiredError,
  UnauthorizedError,
  setCurrentConnectionId,
} from './client';

describe('fetchApi error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCurrentConnectionId(null);
  });

  it('extracts nested license activation error messages from JSON payloads', async () => {
    const nestedErrorPayload = {
      statusCode: 400,
      message: {
        tier: 'community',
        valid: false,
        error: 'Invalid license key',
      },
      error: 'Bad Request',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(nestedErrorPayload), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      fetchApi('/license/activate', {
        method: 'POST',
        body: JSON.stringify({ key: 'test-key' }),
      }),
    ).rejects.toThrow('Invalid license key');
  });

  it('throws PaymentRequiredError for valid 402 payloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Upgrade required',
          feature: 'advanced-analytics',
          currentTier: 'community',
          requiredTier: 'pro',
          upgradeUrl: '/billing',
        }),
        {
          status: 402,
          statusText: 'Payment Required',
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(fetchApi('/premium/feature')).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('falls back to generic status message when response has no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    await expect(fetchApi('/license/activate')).rejects.toThrow('API error: 400 Bad Request');
  });

  it('resolves undefined for 204 No Content responses (e.g. webhook delete)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 204,
        statusText: 'No Content',
      }),
    );

    await expect(fetchApi<void>('/webhooks/123', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('resolves undefined for 200 responses with an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', {
        status: 200,
        statusText: 'OK',
      }),
    );

    await expect(fetchApi<void>('/webhooks/123', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('still parses JSON bodies for successful responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: '123' }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchApi<{ id: string }>('/webhooks/123')).resolves.toEqual({ id: '123' });
  });
});

describe('fetchApi timeoutMs', () => {
  const jsonResponse = (body: string) =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    vi.restoreAllMocks();
    setCurrentConnectionId(null);
  });

  it('applies no timeout when timeoutMs is omitted', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse('{"a":1}')), 300)),
      );

    await expect(fetchApi('/slow')).resolves.toEqual({ a: 1 });
    expect(fetchSpy.mock.calls[0][1]?.signal).toBeUndefined();
  }, 5000);

  it('applies no timeout for non-numeric timeoutMs values', async () => {
    for (const timeoutMs of [undefined, null, NaN] as unknown as number[]) {
      vi.restoreAllMocks();
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse('{"a":1}')), 100)),
        );

      await expect(fetchApi('/slow', { timeoutMs })).resolves.toEqual({ a: 1 });
      expect(fetchSpy.mock.calls[0][1]?.signal).toBeUndefined();
    }
  }, 5000);

  it('aborts a hung request with TimeoutError when timeoutMs is provided', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
            );
          }),
      );

      const assertion = expect(fetchApi('/hung', { timeoutMs: 1000 })).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { timeoutMs: 1, firesAtMs: 1000 },
    { timeoutMs: 0, firesAtMs: 1000 },
    { timeoutMs: -50, firesAtMs: 1000 },
    { timeoutMs: 999_999_999, firesAtMs: 120_000 },
  ])('clamps timeoutMs=$timeoutMs to a $firesAtMs ms abort', async ({ timeoutMs, firesAtMs }) => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
            );
          }),
      );

      let settled: unknown = 'pending';
      const pending = fetchApi('/x', { timeoutMs }).then(
        () => {
          settled = 'resolved';
        },
        (error) => {
          settled = error;
        },
      );
      await vi.advanceTimersByTimeAsync(firesAtMs - 1);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([204, 205])('resolves undefined for empty %i responses', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(fetchApi('/x')).resolves.toBeUndefined();
  });

  it('resolves undefined for empty 200 responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(fetchApi('/x')).resolves.toBeUndefined();
  });
});

describe('fetchApi 401 handling', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/connections', search: '', assign: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('throws UnauthorizedError and redirects to /login with next on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(fetchApi('/connections')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(window.location.assign).toHaveBeenCalledWith('/login?next=%2Fconnections');
  });

  it('does not redirect when skipAuthRedirect is set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(fetchApi('/workspace/me', { skipAuthRedirect: true })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('does not redirect when already on an auth route', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, pathname: '/login', search: '', assign: vi.fn() },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(fetchApi('/connections')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('sends credentials with every request', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    await fetchApi('/health');
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ credentials: 'include' }));
  });
});
