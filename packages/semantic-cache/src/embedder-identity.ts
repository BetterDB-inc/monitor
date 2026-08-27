/**
 * Embedder identity for @betterdb/semantic-cache.
 *
 * An `EmbedFn` is an opaque closure, so a cache cannot tell which model
 * produced the vectors it is holding. Attaching a descriptor makes that
 * knowable, which is what lets the cache refuse to compare vectors across
 * incompatible embedding spaces.
 */
import type { DescribedEmbedFn, EmbedderDescriptor, EmbedFn } from './types';

/**
 * Attach a descriptor to an embedding function.
 *
 * Returns the same function reference; the descriptor is a non-enumerable,
 * read-only property, so the function stays a plain `EmbedFn` to every caller
 * that does not look for it.
 */
export function describeEmbedder(fn: EmbedFn, descriptor: EmbedderDescriptor): DescribedEmbedFn {
  Object.defineProperty(fn, 'descriptor', {
    value: descriptor,
    enumerable: false,
    writable: false,
  });
  return fn as DescribedEmbedFn;
}

/**
 * Render a descriptor as a stable, human-readable identity string.
 *
 * `provider:model`, with sorted `key=value` params appended after `#`. Params
 * are sorted so insertion order cannot change the result, and undefined values
 * are dropped so introducing an option nobody sets cannot invalidate an
 * existing cache.
 */
export function embedderFingerprint(descriptor: EmbedderDescriptor): string {
  const base = `${descriptor.provider}:${descriptor.model}`;
  const params = descriptor.params;
  if (params === undefined) {
    return base;
  }

  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }

  if (parts.length === 0) {
    return base;
  }
  return `${base}#${parts.join('&')}`;
}

/**
 * Read the descriptor off an embedding function.
 *
 * Returns undefined for a hand-rolled closure that was never described, which
 * is what leaves model-change detection inactive for that cache.
 */
export function getEmbedderDescriptor(fn: EmbedFn): EmbedderDescriptor | undefined {
  return (fn as Partial<DescribedEmbedFn>).descriptor;
}
