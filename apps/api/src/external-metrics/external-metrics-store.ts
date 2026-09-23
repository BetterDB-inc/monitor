import { Injectable } from '@nestjs/common';
import type { FieldUpdate } from './otlp-metrics-types';

export type InfoSections = Record<string, Record<string, string>>;

const DEFAULT_STALE_AFTER_MS = 300_000;
const MIN_STALE_AFTER_MS = 1_000;

const COMPOSITE_ORDER: Record<string, string[]> = {
  keyspace: ['keys', 'expires', 'avg_ttl'],
  commandstats: ['calls', 'usec'],
};

const COMPOSITE_PRIMARY: Record<string, string> = {
  keyspace: 'keys',
  commandstats: 'calls',
};

interface Stamped {
  value: string;
  timeMs: number;
}

interface ConnectionSample {
  scalars: Map<string, Stamped & { section: string; field: string }>;
  composites: Map<string, { section: string; field: string; subkeys: Map<string, Stamped> }>;
  version: number | null;
  serverVersion: string | null;
  valkey: boolean;
}

export function resolveStaleAfterMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= MIN_STALE_AFTER_MS ? parsed : DEFAULT_STALE_AFTER_MS;
}

@Injectable()
export class ExternalMetricsStore {
  readonly staleAfterMs = resolveStaleAfterMs(process.env.OTEL_METRICS_STALE_AFTER_MS);
  private readonly samples = new Map<string, ConnectionSample>();

  apply(connectionId: string, updates: FieldUpdate[]): number {
    const sample = this.getOrCreate(connectionId);
    let accepted = 0;
    for (const update of updates) {
      const { target } = update;
      const key = `${target.section}.${target.field}`;
      if (target.kind === 'scalar') {
        const existing = sample.scalars.get(key);
        if (existing && existing.timeMs > update.timeMs) continue;
        sample.scalars.set(key, { section: target.section, field: target.field, value: update.value, timeMs: update.timeMs });
      } else {
        let entry = sample.composites.get(key);
        if (!entry) {
          entry = { section: target.section, field: target.field, subkeys: new Map() };
          sample.composites.set(key, entry);
        }
        const existing = entry.subkeys.get(target.subkey);
        if (existing && existing.timeMs > update.timeMs) continue;
        entry.subkeys.set(target.subkey, { value: update.value, timeMs: update.timeMs });
      }
      accepted += 1;
      sample.version = sample.version === null ? update.timeMs : Math.max(sample.version, update.timeMs);
    }
    return accepted;
  }

  snapshot(connectionId: string, nowMs: number): InfoSections {
    const sample = this.samples.get(connectionId);
    if (!sample) return {};
    const out: InfoSections = {};
    const put = (section: string, field: string, value: string) => {
      (out[section] ??= {})[field] = value;
    };
    for (const entry of sample.scalars.values()) {
      if (this.fresh(entry.timeMs, nowMs)) put(entry.section, entry.field, entry.value);
    }
    for (const entry of sample.composites.values()) {
      const rendered = this.renderComposite(entry.section, entry.subkeys, nowMs);
      if (rendered !== null) put(entry.section, entry.field, rendered);
    }
    if (sample.serverVersion && Object.keys(out).length > 0) put('server', 'redis_version', sample.serverVersion);
    return out;
  }

  isFresh(connectionId: string, nowMs: number): boolean {
    const sample = this.samples.get(connectionId);
    if (!sample) return false;
    for (const entry of sample.scalars.values()) if (this.fresh(entry.timeMs, nowMs)) return true;
    for (const entry of sample.composites.values()) {
      for (const stamped of entry.subkeys.values()) if (this.fresh(stamped.timeMs, nowMs)) return true;
    }
    return false;
  }

  latestVersion(connectionId: string): number | null {
    return this.samples.get(connectionId)?.version ?? null;
  }

  setServerVersion(connectionId: string, version: string): void {
    this.getOrCreate(connectionId).serverVersion = version;
  }

  serverVersion(connectionId: string): string | null {
    return this.samples.get(connectionId)?.serverVersion ?? null;
  }

  markValkey(connectionId: string): void {
    this.getOrCreate(connectionId).valkey = true;
  }

  isValkey(connectionId: string): boolean {
    return this.samples.get(connectionId)?.valkey ?? false;
  }

  clear(connectionId: string): void {
    this.samples.delete(connectionId);
  }

  private fresh(timeMs: number, nowMs: number): boolean {
    return nowMs - timeMs <= this.staleAfterMs;
  }

  private renderComposite(section: string, subkeys: Map<string, Stamped>, nowMs: number): string | null {
    const freshValues = new Map<string, string>();
    for (const [subkey, stamped] of subkeys) {
      if (this.fresh(stamped.timeMs, nowMs)) freshValues.set(subkey, stamped.value);
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
      sample = { scalars: new Map(), composites: new Map(), version: null, serverVersion: null, valkey: false };
      this.samples.set(connectionId, sample);
    }
    return sample;
  }
}
