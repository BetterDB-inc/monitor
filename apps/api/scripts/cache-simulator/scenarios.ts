export interface SeedCommand {
  type: 'string' | 'hash' | 'list' | 'set' | 'zset';
  key: string;
  value: string | string[];
  ttlSeconds?: number;
}

export interface Scenario {
  name: string;
  tolerance: number;
  runs: number;
  generate(seed: number): Iterable<SeedCommand>;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: () => number, min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
const text = (length: number): string => 'x'.repeat(length);
const items = (count: number, length: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index}:${text(length)}`);

function* mixed(random: () => number, prefix: string, counts: { string: number; hash: number; list: number; set: number; zset: number }): Iterable<SeedCommand> {
  for (let index = 0; index < counts.string; index++) yield { type: 'string', key: `${prefix}:s:${index}`, value: text(between(random, 32, 512)) };
  for (let index = 0; index < counts.hash; index++) yield { type: 'hash', key: `${prefix}:h:${index}`, value: items(between(random, 10, 50), 32, 'f') };
  for (let index = 0; index < counts.list; index++) yield { type: 'list', key: `${prefix}:l:${index}`, value: items(between(random, 20, 200), 64, 'i') };
  for (let index = 0; index < counts.set; index++) yield { type: 'set', key: `${prefix}:t:${index}`, value: items(between(random, 10, 100), 32, 'm') };
  for (let index = 0; index < counts.zset; index++) yield { type: 'zset', key: `${prefix}:z:${index}`, value: items(between(random, 10, 100), 32, 'm') };
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'homogeneous-small',
    tolerance: 0.05,
    runs: 10,
    *generate(seed) {
      for (let index = 0; index < 100_000; index++) yield { type: 'string', key: `hs:${seed}:${index}`, value: text(64) };
    },
  },
  {
    name: 'homogeneous-large',
    tolerance: 0.05,
    runs: 10,
    *generate(seed) {
      for (let index = 0; index < 20_000; index++) yield { type: 'string', key: `hl:${seed}:${index}`, value: text(16 * 1024) };
    },
  },
  {
    name: 'mixed',
    tolerance: 0.05,
    runs: 10,
    generate: (seed) => mixed(mulberry32(seed), `mx:${seed}`, { string: 50_000, hash: 10_000, list: 5_000, set: 5_000, zset: 5_000 }),
  },
  {
    name: 'pareto',
    tolerance: 0.1,
    runs: 10,
    *generate(seed) {
      const random = mulberry32(seed);
      for (let index = 0; index < 50_000; index++) {
        const u = 1 - random();
        yield { type: 'string', key: `pa:${seed}:${index}`, value: text(Math.min(1024 * 1024, Math.floor(100 / u ** (1 / 1.5)))) };
      }
    },
  },
  {
    name: 'ttl-mix',
    tolerance: 0.05,
    runs: 10,
    *generate(seed) {
      const random = mulberry32(seed);
      for (let index = 0; index < 50_000; index++) {
        yield { type: 'string', key: `tt:${seed}:${index}`, value: text(256), ...(random() < 0.5 ? { ttlSeconds: 3600 } : {}) };
      }
    },
  },
  {
    name: 'scale-500k',
    tolerance: 0.05,
    runs: 3,
    *generate(seed) {
      const random = mulberry32(seed);
      for (let index = 0; index < 500_000; index++) {
        yield random() < 0.8
          ? { type: 'string', key: `sc:${seed}:${index}`, value: text(between(random, 100, 300)) }
          : { type: 'hash', key: `sc:${seed}:${index}`, value: items(between(random, 5, 20), 32, 'f') };
      }
    },
  },
];
