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

  it.each(providers)('picks the smallest node that keeps %s under 80%% of usable memory', (provider) => {
    const bytes = 10 * GiB;
    for (const pick of smallestNodeFor(bytes, provider).filter((rec) => rec.shards === 1)) {
      const service = CLOUD_SERVICES.find((candidate) => candidate.service === pick.service)!;
      const usable = service.usableRatio * 0.8;
      expect(pick.memoryBytes * usable).toBeGreaterThanOrEqual(bytes);
      const smaller = service.nodes.filter((node) => node.memoryBytes < pick.memoryBytes);
      expect(smaller.every((node) => node.memoryBytes * usable < bytes)).toBe(true);
    }
  });

  it('reserves memory the service keeps back from the dataset', () => {
    const byService = Object.fromEntries(CLOUD_SERVICES.map((service) => [service.service, service.usableRatio]));
    expect(byService).toEqual({
      elasticache: 0.75,
      memorydb: 1,
      'memorystore-valkey': 0.8,
      'azure-cache-standard': 0.8,
      'azure-cache-premium': 0.8,
    });
    const [standardSmall] = smallestNodeFor(4.5e9, 'gcp');
    expect(standardSmall.nodeType).toBe('highmem-medium');
    const memorydb = smallestNodeFor(2.4e9, 'aws').find((rec) => rec.service === 'memorydb');
    expect(memorydb?.nodeType).toBe('db.t4g.medium');
  });

  it('caps GCP shards at one replica per shard and labels Azure as legacy', () => {
    const gcp = CLOUD_SERVICES.find((service) => service.provider === 'gcp')!;
    expect(gcp.maxShards).toBe(125);
    expect(gcp.label).toContain('1 replica per shard');
    for (const service of CLOUD_SERVICES.filter((candidate) => candidate.provider === 'azure')) expect(service.label).toContain('legacy');
  });

  it('falls back to shards of the largest node', () => {
    const bytes = 1024 * GiB;
    const gcp = smallestNodeFor(bytes, 'gcp');
    expect(gcp).toHaveLength(1);
    const service = CLOUD_SERVICES.find((candidate) => candidate.service === gcp[0].service)!;
    const largest = Math.max(...service.nodes.map((node) => node.memoryBytes));
    expect(gcp[0].memoryBytes).toBe(largest);
    expect(gcp[0].shards * largest * service.usableRatio * 0.8).toBeGreaterThanOrEqual(bytes);
    expect((gcp[0].shards - 1) * largest * service.usableRatio * 0.8).toBeLessThan(bytes);
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
