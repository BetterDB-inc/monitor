import { HEADROOM } from './projection';

export type CloudProvider = 'aws' | 'gcp' | 'azure';

export interface CloudNode {
  nodeType: string;
  memoryBytes: number;
}

export interface CloudService {
  provider: CloudProvider;
  service: string;
  label: string;
  maxShards: number;
  sourceUrl: string;
  asOf: string;
  nodes: CloudNode[];
}

export interface NodeRecommendation {
  provider: CloudProvider;
  service: string;
  label: string;
  nodeType: string;
  memoryBytes: number;
  shards: number;
}

const gib = (value: number): number => Math.round(value * 1024 ** 3);
const gb = (value: number): number => Math.round(value * 1e9);
const node = (nodeType: string, memoryBytes: number): CloudNode => ({ nodeType, memoryBytes });
const AS_OF = '2026-10-12';

const R7G: Array<[string, number]> = [
  ['large', 13.07],
  ['xlarge', 26.32],
  ['2xlarge', 52.82],
  ['4xlarge', 105.81],
  ['8xlarge', 209.55],
  ['12xlarge', 317.77],
  ['16xlarge', 419.09],
];

const M7G: Array<[string, number]> = [
  ['large', 6.38],
  ['xlarge', 12.93],
  ['2xlarge', 26.04],
  ['4xlarge', 52.26],
  ['8xlarge', 103.68],
  ['12xlarge', 157.12],
  ['16xlarge', 209.55],
];

export const CLOUD_SERVICES: CloudService[] = [
  {
    provider: 'aws',
    service: 'elasticache',
    label: 'Amazon ElastiCache',
    maxShards: 500,
    sourceUrl: 'https://aws.amazon.com/elasticache/pricing/',
    asOf: AS_OF,
    nodes: [
      node('cache.t4g.micro', gib(0.5)),
      node('cache.t4g.small', gib(1.37)),
      node('cache.t4g.medium', gib(3.09)),
      ...M7G.map(([size, memory]) => node(`cache.m7g.${size}`, gib(memory))),
      ...R7G.map(([size, memory]) => node(`cache.r7g.${size}`, gib(memory))),
    ],
  },
  {
    provider: 'aws',
    service: 'memorydb',
    label: 'Amazon MemoryDB',
    maxShards: 500,
    sourceUrl: 'https://aws.amazon.com/memorydb/pricing/',
    asOf: AS_OF,
    nodes: [
      node('db.t4g.small', gib(1.37)),
      node('db.t4g.medium', gib(3.09)),
      ...R7G.map(([size, memory]) => node(`db.r7g.${size}`, gib(memory))),
    ],
  },
  {
    provider: 'gcp',
    service: 'memorystore-valkey',
    label: 'Memorystore for Valkey',
    maxShards: 250,
    sourceUrl: 'https://cloud.google.com/memorystore/docs/valkey/instance-node-specification',
    asOf: AS_OF,
    nodes: [
      node('shared-core-nano', gb(1.4)),
      node('standard-small', gb(6.5)),
      node('highmem-medium', gb(13)),
      node('highmem-xlarge', gb(58)),
    ],
  },
  {
    provider: 'azure',
    service: 'azure-cache-standard',
    label: 'Azure Cache for Redis (Basic/Standard)',
    maxShards: 1,
    sourceUrl: 'https://azure.microsoft.com/pricing/details/cache/',
    asOf: AS_OF,
    nodes: [
      node('C0', gb(0.25)),
      node('C1', gb(1)),
      node('C2', gb(2.5)),
      node('C3', gb(6)),
      node('C4', gb(13)),
      node('C5', gb(26)),
      node('C6', gb(53)),
    ],
  },
  {
    provider: 'azure',
    service: 'azure-cache-premium',
    label: 'Azure Cache for Redis (Premium)',
    maxShards: 10,
    sourceUrl: 'https://azure.microsoft.com/pricing/details/cache/',
    asOf: AS_OF,
    nodes: [node('P1', gb(6)), node('P2', gb(13)), node('P3', gb(26)), node('P4', gb(53)), node('P5', gb(120))],
  },
];

export function smallestNodeFor(bytes: number, provider: CloudProvider, headroom: number = HEADROOM): NodeRecommendation[] {
  return CLOUD_SERVICES.filter((service) => service.provider === provider).flatMap((service) => {
    const sorted = [...service.nodes].sort((a, b) => a.memoryBytes - b.memoryBytes);
    const base = { provider, service: service.service, label: service.label };
    const single = sorted.find((candidate) => candidate.memoryBytes * headroom >= bytes);
    if (single) return [{ ...base, nodeType: single.nodeType, memoryBytes: single.memoryBytes, shards: 1 }];
    const largest = sorted[sorted.length - 1];
    const shards = Math.ceil(bytes / (largest.memoryBytes * headroom));
    return shards <= service.maxShards ? [{ ...base, nodeType: largest.nodeType, memoryBytes: largest.memoryBytes, shards }] : [];
  });
}
