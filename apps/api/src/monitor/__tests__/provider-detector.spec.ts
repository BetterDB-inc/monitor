import { detectProvider } from '../provider-detector';

describe('detectProvider', () => {
  describe('host-based detection', () => {
    it.each([
      ['my-cluster.abc123.cache.amazonaws.com', 'aws-elasticache'],
      ['my-cluster.serverless.cache.amazonaws.com', 'aws-elasticache'],
      ['redis-12345.c123.us-east-1.gcp.cloud.rlrcp.com', 'redis-cloud'],
      ['redis-12345.c123.us-east-1-1.ec2.redislabs.com', 'redis-cloud'],
      ['my-cache.redis-cloud.com', 'redis-cloud'],
      ['fly-rabbit-12345.upstash.io', 'upstash'],
      ['my-instance.internal.memorystore.googleapis.com', 'gcp-memorystore'],
    ])('matches %s → %s', (host, provider) => {
      const result = detectProvider({}, host);
      expect(result.provider).toBe(provider);
      // Managed providers always come with at least one restriction string.
      if (provider !== 'unknown') {
        expect(result.restrictions.length).toBeGreaterThan(0);
      }
    });

    it('is case-insensitive', () => {
      expect(detectProvider({}, 'MY.CACHE.AMAZONAWS.COM').provider).toBe('aws-elasticache');
    });

    it('returns self-hosted with no restrictions for an unknown host', () => {
      const result = detectProvider({}, 'redis.internal.example.com');
      expect(result.provider).toBe('self-hosted');
      expect(result.restrictions).toEqual([]);
    });
  });

  describe('INFO-based fallback', () => {
    it('detects redis-cloud from redis_build_id containing "redislabs"', () => {
      const result = detectProvider({ redis_build_id: '7eba2e0c5b8d9a6c-redislabs' });
      expect(result.provider).toBe('redis-cloud');
    });

    it('detects aws-elasticache from os containing "Amazon"', () => {
      const result = detectProvider({ os: 'Linux 5.10 Amazon Linux' });
      expect(result.provider).toBe('aws-elasticache');
    });

    it('falls back to self-hosted when nothing matches', () => {
      const result = detectProvider({ os: 'Linux 6.1 Debian', redis_build_id: 'abc123' });
      expect(result.provider).toBe('self-hosted');
    });
  });

  describe('precedence', () => {
    it('host signal wins over INFO signal', () => {
      const result = detectProvider(
        { redis_build_id: '7eba2e0c5b8d9a6c-redislabs' },
        'fly-rabbit-12345.upstash.io',
      );
      expect(result.provider).toBe('upstash');
    });
  });

  describe('graceful degradation', () => {
    it('returns self-hosted when both inputs are empty', () => {
      const result = detectProvider();
      expect(result.provider).toBe('self-hosted');
      expect(result.restrictions).toEqual([]);
    });
  });
});
