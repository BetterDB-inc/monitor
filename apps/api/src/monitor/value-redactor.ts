/**
 * Optional, env-gated MONITOR value redaction. Replaces value-position
 * arguments of well-known write commands with `<redacted>` so chunks
 * persisted to disk and lines streamed to the live tail never contain
 * payload bytes (only keys, command verbs, and structural fields).
 *
 * Coverage is the common write surface; complex grammars (XADD, ZADD,
 * BITFIELD, BITOP) are intentionally NOT scrubbed — operators must
 * leave the toggle off when those payloads are sensitive.
 */

export const REDACTED_PLACEHOLDER = '<redacted>';

type RedactionStrategy = (args: string[]) => string[];

const single = (valueIndex: number): RedactionStrategy => (args) => {
  if (args.length <= valueIndex) {
    return args;
  }
  const out = args.slice();
  out[valueIndex] = REDACTED_PLACEHOLDER;
  return out;
};

const trailing = (firstValueIndex: number): RedactionStrategy => (args) => {
  if (args.length <= firstValueIndex) {
    return args;
  }
  const out = args.slice(0, firstValueIndex);
  for (let i = firstValueIndex; i < args.length; i++) {
    out.push(REDACTED_PLACEHOLDER);
  }
  return out;
};

/** Pair-stride: redact args at firstValueIndex, firstValueIndex+2, ... */
const pairs = (firstValueIndex: number): RedactionStrategy => (args) => {
  if (args.length <= firstValueIndex) {
    return args;
  }
  const out = args.slice();
  for (let i = firstValueIndex; i < out.length; i += 2) {
    out[i] = REDACTED_PLACEHOLDER;
  }
  return out;
};

// Indices in the strategies below are 1-based against the FULL args array
// (so index 0 is always the verb). SET key value → value sits at args[2].
const STRATEGIES: Record<string, RedactionStrategy> = {
  SET: single(2),
  SETEX: single(3),
  PSETEX: single(3),
  SETNX: single(2),
  GETSET: single(2),
  APPEND: single(2),
  LSET: single(3),
  // pivot AND value get redacted for LINSERT (pivot is value-like)
  // Args: [LINSERT, key, BEFORE|AFTER, pivot, value]
  LINSERT: (args) => {
    if (args.length < 5) {
      return args;
    }
    const out = args.slice();
    out[3] = REDACTED_PLACEHOLDER;
    out[4] = REDACTED_PLACEHOLDER;
    return out;
  },
  MSET: pairs(2),
  MSETNX: pairs(2),
  HSET: pairs(3),
  HMSET: pairs(3),
  HSETNX: single(3),
  LPUSH: trailing(2),
  RPUSH: trailing(2),
  LPUSHX: trailing(2),
  RPUSHX: trailing(2),
  SADD: trailing(2),
  SREM: trailing(2),
  PUBLISH: single(2),
  SPUBLISH: single(2),
};

export function redactWriteCommandArgs(args: string[]): string[] {
  if (args.length === 0) {
    return args;
  }
  const verb = String(args[0] ?? '').toUpperCase();
  const strategy = STRATEGIES[verb];
  if (!strategy) {
    return args;
  }
  return strategy(args);
}

export function isRedactionEnabled(): boolean {
  return process.env.MONITOR_REDACT_VALUES === 'true';
}
