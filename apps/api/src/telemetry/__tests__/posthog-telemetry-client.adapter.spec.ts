import { PosthogTelemetryClientAdapter } from '../adapters/posthog-telemetry-client.adapter';

const mockCapture = jest.fn();
const mockIdentify = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    identify: mockIdentify,
    shutdown: mockShutdown,
  })),
}));

describe('PosthogTelemetryClientAdapter', () => {
  let adapter: PosthogTelemetryClientAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new PosthogTelemetryClientAdapter('phc_test_key');
  });

  it('should initialize PostHog client with api key', () => {
    const { PostHog } = require('posthog-node');
    expect(PostHog).toHaveBeenCalledWith('phc_test_key', expect.objectContaining({}));
  });

  it('should initialize PostHog client with custom host', () => {
    jest.clearAllMocks();
    const _adapter = new PosthogTelemetryClientAdapter('phc_key', 'https://ph.example.com');
    const { PostHog } = require('posthog-node');
    expect(PostHog).toHaveBeenCalledWith(
      'phc_key',
      expect.objectContaining({ host: 'https://ph.example.com' }),
    );
  });

  it('should delegate capture to posthog.capture', () => {
    adapter.capture({
      distinctId: 'inst-123',
      event: 'app_start',
      properties: { version: '0.13.0' },
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'inst-123',
      event: 'app_start',
      properties: { version: '0.13.0' },
    });
  });

  it('should delegate identify to posthog.identify', () => {
    adapter.identify('inst-123', { tier: 'pro', version: '0.13.0' });

    expect(mockIdentify).toHaveBeenCalledWith({
      distinctId: 'inst-123',
      properties: { tier: 'pro', version: '0.13.0' },
    });
  });

  it('should delegate shutdown to posthog.shutdown', async () => {
    await adapter.shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });
});
