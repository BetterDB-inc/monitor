import { describe, it, expect, vi, beforeEach } from 'vitest';
import {TEST_VERSION} from './constants'


const { mockInstance } = vi.hoisted(() => ({
  mockInstance: {
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn().mockReturnValue(mockInstance),
  },
}));

import posthog from 'posthog-js';
import { PosthogTelemetryClient } from '../clients/posthog-telemetry-client';

const mockInit = vi.mocked(posthog.init);

describe('PosthogTelemetryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInit.mockReturnValue(mockInstance as never);
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

    expect(mockInstance.capture).toHaveBeenCalledWith('$pageview', { path: '/dashboard' });
  });

  it('should pass other events through unchanged', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.capture('interaction_after_idle', { idleDurationMs: 300000 });

    expect(mockInstance.capture).toHaveBeenCalledWith('interaction_after_idle', { idleDurationMs: 300000 });
  });

  it('should delegate identify to posthog.identify', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.identify('inst-123', { tier: 'pro', version: TEST_VERSION });

    expect(mockInstance.identify).toHaveBeenCalledWith('inst-123', { tier: 'pro', version: TEST_VERSION });
  });

  it('should call reset on shutdown', () => {
    const client = new PosthogTelemetryClient('phc_key');
    client.shutdown();

    expect(mockInstance.reset).toHaveBeenCalled();
  });
});