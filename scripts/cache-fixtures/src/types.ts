import type { EmbedFn } from '@betterdb/semantic-cache';

export interface ScenarioContext {
  valkeyHost: string;
  valkeyPort: number;
  valkeyPassword?: string;
  cacheName: string;
  embedFn: EmbedFn;
}

export interface ScenarioResult {
  entries: number;
  details?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  description: string;
  cacheKind: 'semantic' | 'agent';
  defaultCacheName: string;
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}
