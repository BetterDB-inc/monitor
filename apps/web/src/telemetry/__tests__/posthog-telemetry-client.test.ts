import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

import posthog from 'posthog-js';
import { PosthogTelemetryClient } from '../clients/posthog-telemetry-client';

const mockInit = vi.mocked(posthog.init);
const mockCapture = vi.mocked(posthog.capture);
const mockIdentify = vi.mocked(posthog.identify);
const mockReset = vi.mocked(posthog.reset);

describe('PosthogTelemetryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize posthog with API key and host', () => {
    const _client = new PosthogTelemetryClient('phc_test_key', 'https://ph.example.com');

    expect(mockInit).toHaveBeenCalledWith('phc_test_key', expect.objectContaining({
      api_host: 'https://ph.example.com',
    }));
  });

  it('should map page_view to $pageview on capture', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.capture('page_view', { path: '/dashboard' });

    expect(mockCapture).toHaveBeenCalledWith('$pageview', { path: '/dashboard' });
  });

  it('should pass other events through unchanged', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.capture('interaction_after_idle', { idleDurationMs: 300000 });

    expect(mockCapture).toHaveBeenCalledWith('interaction_after_idle', { idleDurationMs: 300000 });
  });

  it('should delegate identify to posthog.identify', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.identify('inst-123', { tier: 'pro', version: '0.12.0' });

    expect(mockIdentify).toHaveBeenCalledWith('inst-123', { tier: 'pro', version: '0.12.0' });
  });

  it('should call posthog.reset on shutdown', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.shutdown();

    expect(mockReset).toHaveBeenCalled();
  });
});
