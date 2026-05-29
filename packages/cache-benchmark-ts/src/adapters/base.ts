import type { CheckResult, AdapterMode } from '../types.js';

export abstract class CacheAdapter {
  constructor(
    public readonly threshold: number,
    public readonly embeddingModel: string,
    public readonly redisUrl: string,
    public readonly mode: AdapterMode,
  ) {}

  abstract get name(): string;
  abstract enabledFeatures(): string[];

  async initialize(): Promise<void> {}
  abstract store(prompt: string, response: string): Promise<void>;
  abstract check(prompt: string): Promise<CheckResult>;
  abstract clear(): Promise<void>;
  async close(): Promise<void> {}
}
