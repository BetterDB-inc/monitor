import type Valkey from 'iovalkey';
import { execPipeline } from './pipeline-results';

/**
 * Per-field TTLs (Hash Field Expiry, Valkey 9.0+ / Redis 7.4+) for command-mode
 * hash migration. TTLs are copied relative (HPTTL -> HPEXPIRE), like the
 * key-level PTTL -> PEXPIRE in type-handlers, so the copy does not depend on
 * the two servers' clocks agreeing.
 */

export type HfeSupport = 'unknown' | 'supported' | 'unsupported' | 'denied';

/** One per migration run: memoizes each side's HFE support so the probe runs once. */
export interface HashFieldTtlContext {
  source: HfeSupport;
  target: Exclude<HfeSupport, 'denied'>;
  /** Fields whose TTL was re-applied on the target. */
  fieldsWithTtl: number;
}

export function createHashFieldTtlContext(): HashFieldTtlContext {
  return { source: 'unknown', target: 'unknown', fieldsWithTtl: 0 };
}

const UNKNOWN_COMMAND_RE = /unknown command|unknown subcommand/i;
const NOPERM_RE = /NOPERM/i;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function targetLacksHfeError(fieldCount: number): Error {
  return new Error(
    `target does not support hash field expiry (needs Valkey 9.0+ or Redis 7.4+); ` +
      `${fieldCount} field TTL(s) would be lost`,
  );
}

/**
 * HPTTL for one HSCAN page of field names. Returns null when field TTLs
 * cannot exist or cannot be read (source without HFE, or HPTTL denied), in
 * which case the caller copies the page without field TTLs, as before.
 */
export async function readFieldTtls(
  source: Valkey,
  key: string,
  fields: Buffer[],
  ctx: HashFieldTtlContext,
): Promise<number[] | null> {
  if (fields.length === 0 || ctx.source === 'unsupported' || ctx.source === 'denied') return null;
  try {
    const raw = (await source.call(
      'HPTTL',
      key,
      'FIELDS',
      String(fields.length),
      ...fields,
    )) as unknown[];
    ctx.source = 'supported';
    return raw.map((v) => Number(v));
  } catch (err) {
    const msg = messageOf(err);
    if (UNKNOWN_COMMAND_RE.test(msg)) {
      ctx.source = 'unsupported';
      return null;
    }
    if (NOPERM_RE.test(msg)) {
      ctx.source = 'denied';
      return null;
    }
    throw err;
  }
}

/**
 * Re-apply one page's field TTLs on the write key. ttls[i] belongs to fields[i].
 * -1: no TTL. -2: field expired after it was read, so remove it.
 * Returns the number of fields given a TTL. Throws when the target cannot store field TTLs.
 */
export async function applyFieldTtls(
  target: Valkey,
  writeKey: string,
  fields: Buffer[],
  ttls: number[],
  ctx: HashFieldTtlContext,
): Promise<number> {
  const byTtl = new Map<number, Buffer[]>();
  const expired: Buffer[] = [];
  ttls.forEach((ttl, i) => {
    if (ttl > 0) {
      const group = byTtl.get(ttl);
      if (group) group.push(fields[i]);
      else byTtl.set(ttl, [fields[i]]);
    } else if (ttl === -2) {
      expired.push(fields[i]);
    }
  });

  if (expired.length > 0) await target.call('HDEL', writeKey, ...expired);

  const withTtl = [...byTtl.values()].reduce((n, g) => n + g.length, 0);
  if (withTtl === 0) return 0;
  if (ctx.target === 'unsupported') throw targetLacksHfeError(withTtl);

  const pipeline = target.pipeline();
  for (const [ttl, group] of byTtl) {
    pipeline.call('HPEXPIRE', writeKey, String(ttl), 'FIELDS', String(group.length), ...group);
  }
  try {
    await execPipeline(pipeline);
  } catch (err) {
    if (UNKNOWN_COMMAND_RE.test(messageOf(err))) {
      ctx.target = 'unsupported';
      throw targetLacksHfeError(withTtl);
    }
    throw err;
  }
  ctx.target = 'supported';
  ctx.fieldsWithTtl += withTtl;
  return withTtl;
}
