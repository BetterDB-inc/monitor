import { CLOUD_SERVICES, smallestNodeFor, type CloudProvider } from '@betterdb/shared';

const GiB = 1024 ** 3;
const providers: CloudProvider[] = ['aws', 'gcp', 'azure'];

describe('node catalog', () => {
  it('covers AWS, GCP and Azure with sources', () => {
    expect(new Set(CLOUD_SERVICES.map((service) => service.provider))).toEqual(new Set(providers));
    for (const service of CLOUD_SERVICES) {
      expect(service.sourceUrl).toMatch(/^https:\/\//);
      expect(service.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(service.nodes.length).toBeGreaterThan(0);
    }
  });

  it.each(providers)('picks the smallest node that keeps %s under 80%%', (provider) => {
    const bytes = 10 * GiB;
    for (const pick of smallestNodeFor(bytes, provider).filter((rec) => rec.shards === 1)) {
      const service = CLOUD_SERVICES.find((candidate) => candidate.service === pick.service)!;
      expect(pick.memoryBytes * 0.8).toBeGreaterThanOrEqual(bytes);
      const smaller = service.nodes.filter((node) => node.memoryBytes < pick.memoryBytes);
      expect(smaller.every((node) => node.memoryBytes * 0.8 < bytes)).toBe(true);
    }
  });

  it('falls back to shards of the largest node', () => {
    const bytes = 1024 * GiB;
    const gcp = smallestNodeFor(bytes, 'gcp');
    expect(gcp).toHaveLength(1);
    const service = CLOUD_SERVICES.find((candidate) => candidate.service === gcp[0].service)!;
    const largest = Math.max(...service.nodes.map((node) => node.memoryBytes));
    expect(gcp[0].memoryBytes).toBe(largest);
    expect(gcp[0].shards * largest * 0.8).toBeGreaterThanOrEqual(bytes);
    expect((gcp[0].shards - 1) * largest * 0.8).toBeLessThan(bytes);
  });

  it('omits services whose shard limit cannot hold the data', () => {
    const services = smallestNodeFor(2048 * GiB, 'azure').map((rec) => rec.service);
    expect(services).not.toContain('azure-cache-standard');
    expect(services).not.toContain('azure-cache-premium');
  });

  it('returns one recommendation per service for small data', () => {
    expect(smallestNodeFor(1024, 'aws').map((rec) => rec.service).sort()).toEqual(['elasticache', 'memorydb']);
  });
});
