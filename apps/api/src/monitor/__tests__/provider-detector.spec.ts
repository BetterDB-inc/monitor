import {
  detectProvider,
  isManagedProviderBuild,
  isManagedProviderHost,
} from '../provider-detector';

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
      // Managed providers carry the generic advisory notice (the authoritative
      // "is MONITOR supported?" answer comes from MonitorSupportProbe).
      if (provider !== 'unknown') {
        expect(result.restrictions.length).toBeGreaterThan(0);
        expect(result.restrictions[0]).toMatch(/info@betterdb\.com/);
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

  describe('MONITOR_PROVIDER_OVERRIDE env', () => {
    let original: string | undefined;
    beforeEach(() => {
      original = process.env.MONITOR_PROVIDER_OVERRIDE;
    });
    afterEach(() => {
      if (original === undefined) {
        delete process.env.MONITOR_PROVIDER_OVERRIDE;
      } else {
        process.env.MONITOR_PROVIDER_OVERRIDE = original;
      }
    });

    it('forces aws-elasticache when set to "elasticache"', () => {
      process.env.MONITOR_PROVIDER_OVERRIDE = 'elasticache';
      const result = detectProvider({}, 'localhost');
      expect(result.provider).toBe('aws-elasticache');
      expect(result.restrictions.length).toBeGreaterThan(0);
    });

    it('accepts the canonical id "aws-elasticache" too', () => {
      process.env.MONITOR_PROVIDER_OVERRIDE = 'aws-elasticache';
      expect(detectProvider({}, 'localhost').provider).toBe('aws-elasticache');
    });

    it('overrides a real host signal — useful for QA without touching DNS', () => {
      process.env.MONITOR_PROVIDER_OVERRIDE = 'memorystore';
      const result = detectProvider({}, 'fly-rabbit.upstash.io');
      expect(result.provider).toBe('gcp-memorystore');
    });

    it('ignores an unknown override value (falls through to detection)', () => {
      process.env.MONITOR_PROVIDER_OVERRIDE = 'made-up-provider';
      const result = detectProvider({}, 'fly-rabbit.upstash.io');
      expect(result.provider).toBe('upstash');
    });

    it('is case-insensitive', () => {
      process.env.MONITOR_PROVIDER_OVERRIDE = 'ELASTICACHE';
      expect(detectProvider({}).provider).toBe('aws-elasticache');
    });
  });
});

describe('isManagedProviderBuild', () => {
  it.each(['redislabs-5f0e1b2c', 'RedisLabs-5f0e1b2c'])(
    'knows the build %s as a managed one',
    (buildId) => {
      expect(isManagedProviderBuild({ redis_build_id: buildId })).toBe(true);
    },
  );

  it.each([[{ redis_build_id: '5f0e1b2c3d4a' }], [{ os: 'Amazon Linux 2023' }], [{}], [undefined]])(
    'does not call %j a managed build',
    (server) => {
      expect(isManagedProviderBuild(server)).toBe(false);
    },
  );
});

describe('isManagedProviderHost', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.MONITOR_PROVIDER_OVERRIDE;
    delete process.env.MONITOR_PROVIDER_OVERRIDE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MONITOR_PROVIDER_OVERRIDE;
    else process.env.MONITOR_PROVIDER_OVERRIDE = original;
  });

  it.each([
    'my-cluster.abc123.clustercfg.use1.cache.amazonaws.com',
    'my-cluster.serverless.cache.amazonaws.com',
    'redis-12345.c123.us-east-1.gcp.cloud.rlrcp.com',
    'my-cache.redis-cloud.com',
    'fly-rabbit-12345.upstash.io',
    'my-instance.internal.memorystore.googleapis.com',
    'MY.CACHE.AMAZONAWS.COM',
  ])('knows %s as a managed service', (host) => {
    expect(isManagedProviderHost(host)).toBe(true);
  });

  it.each(['redis.internal.example.com', '10.0.0.1', '', undefined])(
    'does not call %s a managed service',
    (host) => {
      expect(isManagedProviderHost(host)).toBe(false);
    },
  );

  it('does not call a host managed while its provider is unknown', () => {
    expect(isManagedProviderHost('my-cache.redis.cache.windows.net')).toBe(false);
  });

  it('ignores the MONITOR provider override', () => {
    process.env.MONITOR_PROVIDER_OVERRIDE = 'elasticache';

    expect(isManagedProviderHost('redis.internal.example.com')).toBe(false);
  });
});
