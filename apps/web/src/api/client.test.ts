import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApi, PaymentRequiredError, setCurrentConnectionId } from './client';

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
