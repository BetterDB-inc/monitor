import { Injectable, Logger } from '@nestjs/common';
import type { FieldUpdate } from './otlp-metrics-types';
import { otelMetricsStaleAfterMsSchema } from '../config/env.schema';

export type InfoSections = Record<string, Record<string, string>>;

const COMPOSITE_ORDER: Record<string, string[]> = {
  keyspace: ['keys', 'expires', 'avg_ttl'],
  commandstats: ['calls', 'usec'],
};

const COMPOSITE_PRIMARY: Record<string, string> = {
  keyspace: 'keys',
  commandstats: 'calls',
};

const COMPOSITE_LIMIT: Record<string, number> = {
  keyspace: 256,
  commandstats: 1024,
};

interface Stamped {
  value: string;
  timeMs: number;
  receivedMs: number;
}

interface CompositeEntry {
  section: string;
  field: string;
  subkeys: Map<string, Stamped>;
}

export interface ApplyResult {
  accepted: number;
  rejected: number;
}

export type EngineProduct = 'redis' | 'valkey';

export interface EngineVersion {
  product: EngineProduct;
  version: string | null;
}

export const ENGINE_VERSION_ATTRIBUTE: Record<EngineProduct, string> = {
  redis: 'redis.version',
  valkey: 'valkey.version',
};

type EngineChangeListener = (connectionId: string) => void;

interface ConnectionSample {
  scalars: Map<string, Stamped & { section: string; field: string }>;
  composites: Map<string, Map<string, CompositeEntry>>;
  version: number | null;
  redisVersion: string | null;
  valkeyVersion: string | null;
  valkey: boolean;
}

function isSame(existing: Stamped, update: FieldUpdate): boolean {
  return existing.timeMs === update.timeMs && existing.value === update.value;
}

function resolveEngine(sample: ConnectionSample): EngineVersion {
  if (sample.valkey) return { product: 'valkey', version: sample.valkeyVersion };
  return { product: 'redis', version: sample.redisVersion };
}

function engineKey(engine: EngineVersion): string {
  return `${engine.product}|${engine.version ?? ''}`;
}

@Injectable()
export class ExternalMetricsStore {
  readonly staleAfterMs = otelMetricsStaleAfterMsSchema.parse(
    process.env.OTEL_METRICS_STALE_AFTER_MS,
  );
  private readonly logger = new Logger(ExternalMetricsStore.name);
  private readonly samples = new Map<string, ConnectionSample>();
  private readonly engineListeners = new Set<EngineChangeListener>();
  private revision = 0;

  apply(connectionId: string, updates: FieldUpdate[], nowMs: number = Date.now()): ApplyResult {
    const sample = this.getOrCreate(connectionId);
    this.pruneStaleComposites(sample, nowMs);
    let accepted = 0;
    let rejected = 0;
    let changed = false;
    for (const update of updates) {
      const { target } = update;
      if (target.kind === 'scalar') {
        const key = `${target.section}.${target.field}`;
        const existing = sample.scalars.get(key);
        if (existing && existing.timeMs > update.timeMs) continue;
        accepted += 1;
        if (existing && isSame(existing, update)) {
          existing.receivedMs = nowMs;
          continue;
        }
        sample.scalars.set(key, {
          section: target.section,
          field: target.field,
          value: update.value,
          timeMs: update.timeMs,
          receivedMs: nowMs,
        });
      } else {
        let entries = sample.composites.get(target.section);
        if (!entries) {
          entries = new Map();
          sample.composites.set(target.section, entries);
        }
        let entry = entries.get(target.field);
        if (!entry) {
          if (entries.size >= COMPOSITE_LIMIT[target.section]) {
            rejected += 1;
            continue;
          }
          entry = { section: target.section, field: target.field, subkeys: new Map() };
          entries.set(target.field, entry);
        }
        const existing = entry.subkeys.get(target.subkey);
        if (existing && existing.timeMs > update.timeMs) continue;
        accepted += 1;
        if (existing && isSame(existing, update)) {
          existing.receivedMs = nowMs;
          continue;
        }
        entry.subkeys.set(target.subkey, { value: update.value, timeMs: update.timeMs, receivedMs: nowMs });
      }
      changed = true;
    }
    if (changed) sample.version = ++this.revision;
    return { accepted, rejected };
  }

  snapshot(connectionId: string, nowMs: number): InfoSections {
    const sample = this.samples.get(connectionId);
    if (!sample) return {};
    const out: InfoSections = {};
    const put = (section: string, field: string, value: string) => {
      (out[section] ??= {})[field] = value;
    };
    for (const entry of sample.scalars.values()) {
      if (this.fresh(entry, nowMs)) put(entry.section, entry.field, entry.value);
    }
    for (const entries of sample.composites.values()) {
      for (const entry of entries.values()) {
        const rendered = this.renderComposite(entry.section, entry.subkeys, nowMs);
        if (rendered !== null) put(entry.section, entry.field, rendered);
      }
    }
    if (Object.keys(out).length > 0) {
      if (sample.redisVersion) put('server', 'redis_version', sample.redisVersion);
      if (sample.valkey && sample.valkeyVersion) put('server', 'valkey_version', sample.valkeyVersion);
    }
    return out;
  }

  isFresh(connectionId: string, nowMs: number): boolean {
    const sample = this.samples.get(connectionId);
    if (!sample) return false;
    for (const entry of sample.scalars.values()) if (this.fresh(entry, nowMs)) return true;
    for (const entries of sample.composites.values()) {
      for (const entry of entries.values()) {
        const primary = entry.subkeys.get(COMPOSITE_PRIMARY[entry.section]);
        if (primary && this.fresh(primary, nowMs)) return true;
      }
    }
    return false;
  }

  latestVersion(connectionId: string): number | null {
    return this.samples.get(connectionId)?.version ?? null;
  }

  setRedisVersion(connectionId: string, version: string): void {
    this.updateEngine(connectionId, (sample) => {
      sample.redisVersion = version;
    });
  }

  redisVersion(connectionId: string): string | null {
    return this.samples.get(connectionId)?.redisVersion ?? null;
  }

  setValkeyVersion(connectionId: string, version: string): void {
    this.updateEngine(connectionId, (sample) => {
      sample.valkeyVersion = version;
    });
  }

  markValkey(connectionId: string): void {
    this.updateEngine(connectionId, (sample) => {
      sample.valkey = true;
    });
  }

  engineVersion(connectionId: string): EngineVersion {
    const sample = this.samples.get(connectionId);
    return sample ? resolveEngine(sample) : { product: 'redis', version: null };
  }

  onEngineChange(listener: EngineChangeListener): () => void {
    this.engineListeners.add(listener);
    return () => {
      this.engineListeners.delete(listener);
    };
  }

  isValkey(connectionId: string): boolean {
    return this.samples.get(connectionId)?.valkey ?? false;
  }

  clear(connectionId: string): void {
    this.samples.delete(connectionId);
  }

  private updateEngine(connectionId: string, mutate: (sample: ConnectionSample) => void): void {
    const sample = this.getOrCreate(connectionId);
    const before = engineKey(resolveEngine(sample));
    mutate(sample);
    const after = resolveEngine(sample);
    if (after.version === null || engineKey(after) === before) return;
    this.notifyEngineChange(connectionId);
  }

  private notifyEngineChange(connectionId: string): void {
    for (const listener of this.engineListeners) {
      try {
        listener(connectionId);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Engine change listener failed for connection ${connectionId}: ${reason}`);
      }
    }
  }

  private fresh(stamped: Stamped, nowMs: number): boolean {
    return nowMs - stamped.receivedMs <= this.staleAfterMs;
  }

  private pruneStaleComposites(sample: ConnectionSample, nowMs: number): void {
    for (const entries of sample.composites.values()) {
      for (const [field, entry] of entries) {
        const stale = [...entry.subkeys.values()].every((stamped) => !this.fresh(stamped, nowMs));
        if (stale) entries.delete(field);
      }
    }
  }

  private renderComposite(section: string, subkeys: Map<string, Stamped>, nowMs: number): string | null {
    const freshValues = new Map<string, string>();
    for (const [subkey, stamped] of subkeys) {
      if (this.fresh(stamped, nowMs)) freshValues.set(subkey, stamped.value);
    }
    if (!freshValues.has(COMPOSITE_PRIMARY[section])) return null;
    const parts = COMPOSITE_ORDER[section]
      .filter((subkey) => freshValues.has(subkey))
      .map((subkey) => `${subkey}=${freshValues.get(subkey)}`);
    if (section === 'commandstats') {
      const calls = Number(freshValues.get('calls'));
      const usec = Number(freshValues.get('usec'));
      if (freshValues.has('usec') && calls > 0) parts.push(`usec_per_call=${(usec / calls).toFixed(2)}`);
    }
    return parts.join(',');
  }

  private getOrCreate(connectionId: string): ConnectionSample {
    let sample = this.samples.get(connectionId);
    if (!sample) {
      sample = {
        scalars: new Map(),
        composites: new Map(),
        version: null,
        redisVersion: null,
        valkeyVersion: null,
        valkey: false,
      };
      this.samples.set(connectionId, sample);
    }
    return sample;
  }
}
