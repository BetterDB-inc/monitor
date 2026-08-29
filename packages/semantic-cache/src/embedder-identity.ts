/**
 * Embedder identity for @betterdb/semantic-cache.
 *
 * An `EmbedFn` is an opaque closure, so a cache cannot tell which model
 * produced the vectors it is holding. Attaching a descriptor makes that
 * knowable, which is what lets the cache refuse to compare vectors across
 * incompatible embedding spaces.
 */
import { SemanticCacheUsageError } from './errors';
import type { DescribedEmbedFn, EmbedderDescriptor, EmbedFn } from './types';

/**
 * Attach a descriptor to an embedding function.
 *
 * Returns the same function reference; the descriptor is a non-enumerable,
 * read-only property, so the function stays a plain `EmbedFn` to every caller
 * that does not look for it.
 *
 * The descriptor is snapshotted and frozen rather than stored by reference.
 * A cache reads it once to compute its fingerprint and again when it writes
 * its discovery marker; a caller still holding the original object could
 * otherwise change the model between those two reads and have the marker
 * claim a model the vectors were never embedded with.
 *
 * Describing the same function twice is allowed when both descriptors agree —
 * a module-level embedder passed through two factories is the ordinary case.
 * A second, conflicting descriptor throws: the property stays non-configurable
 * on purpose, because a descriptor that can be swapped after the fact is the
 * exact hole the snapshot closes.
 */
export function describeEmbedder(fn: EmbedFn, descriptor: EmbedderDescriptor): DescribedEmbedFn {
  const snapshot: EmbedderDescriptor = {
    provider: descriptor.provider,
    model: descriptor.model,
  };
  if (descriptor.params !== undefined) {
    snapshot.params = Object.freeze({ ...descriptor.params });
  }

  const existing = getEmbedderDescriptor(fn);
  if (existing !== undefined) {
    if (embedderFingerprint(existing) === embedderFingerprint(snapshot)) {
      return fn as DescribedEmbedFn;
    }
    throw new SemanticCacheUsageError(
      `describeEmbedder: this function is already described as ` +
        `'${embedderFingerprint(existing)}' and cannot be redescribed as ` +
        `'${embedderFingerprint(snapshot)}'. Wrap each model in its own function.`,
    );
  }

  Object.defineProperty(fn, 'descriptor', {
    value: Object.freeze(snapshot),
    enumerable: false,
    writable: false,
  });
  return fn as DescribedEmbedFn;
}

/**
 * Render a descriptor as a stable identity string.
 *
 * `provider:model`, with sorted `key=value` params appended after `#`. Params
 * are sorted so insertion order cannot change the result, and undefined values
 * are dropped so introducing an option nobody sets cannot invalidate an
 * existing cache.
 *
 * Every component is percent-encoded, which is what makes the separators
 * unambiguous: without it `{ a: 'x&b=y' }` and `{ a: 'x', b: 'y' }` render
 * identically, and two embedders that share a fingerprint share both the
 * discovery identity and the embedding-cache namespace. Model names carrying
 * a separator — `nomic-embed-text:latest` — are the everyday case.
 * `embedding_descriptor` on the marker keeps the readable form.
 */
export function embedderFingerprint(descriptor: EmbedderDescriptor): string {
  const base = `${encodeURIComponent(descriptor.provider)}:${encodeURIComponent(descriptor.model)}`;
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
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
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
