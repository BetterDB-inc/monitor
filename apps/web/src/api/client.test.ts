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
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await fetchApi('/health');
    expect(spy.mock.calls[0][1]).toEqual(expect.objectContaining({ credentials: 'include' }));
  });
});
