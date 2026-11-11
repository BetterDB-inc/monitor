// Messaging-shaped key schema shared by warm (preload) and app-gen (steady load).
// Every key carries its user id as a hash tag, so a user's keys co-locate on one
// slot and users spread uniformly over the 16384 slots.
import type { SimConfig } from '../config.js';

export const profileKey = (uid: number) => `user:{${uid}}:profile`;
export const counterKey = (uid: number) => `user:{${uid}}:sent`;
export const rateLimitKey = (uid: number, minute: number) => `rl:{${uid}}:${minute}`;
export const dedupKey = (uid: number) => `dedup:{${uid}}`;
export const inboxKey = (uid: number) => `inbox:{${uid}}`;

export const PROFILE_FIELDS = ['name', 'email', 'tz', 'locale', 'last_seen', 'segment', 'attrs'] as const;

// Deterministic PRNG (mulberry32): same seed → same key/value sequence on every run.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const intIn = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// How many of `dataset.keys` each key family gets.
export function datasetPlan(cfg: SimConfig) {
  const d = cfg.dataset;
  const users = Math.floor(d.keys * d.mix.profiles);
  return {
    users,
    counters: Math.floor(d.keys * d.mix.counters),
    dedupSets: Math.floor(d.keys * d.mix.dedupSets),
    inboxes: Math.floor(d.keys * d.mix.inboxes),
  };
}

// Rough resident bytes for the warm dataset (value + per-key/field overhead).
export function projectedBytes(cfg: SimConfig) {
  const p = datasetPlan(cfg);
  const d = cfg.dataset;
  const avgValue = (d.valueBytes[0] + d.valueBytes[1]) / 2;
  const o = d.overheadBytes;
  return (
    p.users * (avgValue + o.key + PROFILE_FIELDS.length * o.field) +
    p.counters * o.key +
    p.dedupSets * (o.key + d.setMembers * (o.field + d.memberBytes)) +
    p.inboxes * (o.key + d.setMembers * (o.field + d.memberBytes))
  );
}

export function profileValue(r: () => number, uid: number, cfg: SimConfig): Record<string, string> {
  const total = intIn(r, cfg.dataset.valueBytes[0], cfg.dataset.valueBytes[1]);
  const base: Record<string, string> = {
    name: `user-${uid}`,
    email: `u${uid}@example.test`,
    tz: ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo'][uid % 4]!,
    locale: ['en', 'de', 'ja', 'pt'][uid % 4]!,
    last_seen: String(1_700_000_000 + uid),
    segment: `s${uid % 97}`,
  };
  const used = Object.values(base).reduce((a, v) => a + v.length, 0);
  base.attrs = 'x'.repeat(Math.max(0, total - used));
  return base;
}
