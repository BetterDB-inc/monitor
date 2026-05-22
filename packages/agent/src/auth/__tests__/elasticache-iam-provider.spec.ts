import { ElastiCacheIamProvider } from '../elasticache-iam-provider';

const FAKE_CREDS = async () => ({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

describe('ElastiCacheIamProvider', () => {
  it('throws when required config is missing', () => {
    expect(() => new ElastiCacheIamProvider({ region: '', resourceName: 'x', userId: 'y' }))
      .toThrow(/region/);
    expect(() => new ElastiCacheIamProvider({ region: 'us-east-1', resourceName: '', userId: 'y' }))
      .toThrow(/resourceName/);
    expect(() => new ElastiCacheIamProvider({ region: 'us-east-1', resourceName: 'x', userId: '' }))
      .toThrow(/userId/);
  });

  it('produces a signed URL with the expected structure', async () => {
    const provider = new ElastiCacheIamProvider({
      region: 'us-east-1',
      resourceName: 'my-cluster',
      userId: 'iam-user-01',
      credentials: FAKE_CREDS,
    });

    const token = await provider.getToken();

    // Must not include the scheme prefix.
    expect(token.startsWith('http')).toBe(false);
    // The host (cache name) must come first.
    expect(token.startsWith('my-cluster/')).toBe(true);
    // SigV4 query params must all be present.
    expect(token).toContain('Action=connect');
    expect(token).toContain('User=iam-user-01');
    expect(token).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(token).toContain('X-Amz-Credential=');
    expect(token).toContain('X-Amz-Date=');
    expect(token).toContain('X-Amz-Expires=900');
    expect(token).toContain('X-Amz-SignedHeaders=host');
    expect(token).toContain('X-Amz-Signature=');
    // The credential scope must reference the elasticache service.
    expect(token).toMatch(/X-Amz-Credential=[^&]*%2Felasticache%2Faws4_request/);
  });

  it('adds ResourceType=ServerlessCache when serverless=true', async () => {
    const provider = new ElastiCacheIamProvider({
      region: 'us-east-1',
      resourceName: 'my-serverless-cache',
      userId: 'iam-user-01',
      serverless: true,
      credentials: FAKE_CREDS,
    });

    const token = await provider.getToken();
    expect(token).toContain('ResourceType=ServerlessCache');
  });

  it('omits ResourceType when serverless is false', async () => {
    const provider = new ElastiCacheIamProvider({
      region: 'us-east-1',
      resourceName: 'my-cluster',
      userId: 'iam-user-01',
      serverless: false,
      credentials: FAKE_CREDS,
    });

    const token = await provider.getToken();
    expect(token).not.toContain('ResourceType');
  });

  it('generates a different signature on subsequent calls (token freshness)', async () => {
    jest.useFakeTimers();
    try {
      const provider = new ElastiCacheIamProvider({
        region: 'us-east-1',
        resourceName: 'my-cluster',
        userId: 'iam-user-01',
        credentials: FAKE_CREDS,
      });

      const t1 = await provider.getToken();
      // Advance fake clock by 61 seconds so X-Amz-Date changes
      jest.setSystemTime(Date.now() + 61000);
      const t2 = await provider.getToken();

      expect(t1).not.toBe(t2);
    } finally {
      jest.useRealTimers();
    }
  });
});
