import { createHash } from 'node:crypto';

/**
 * Deterministic, dimension-configurable embedding for hermetic unit tests:
 * the same text always maps to the same normalized vector, so similarity is
 * predictable without a real embedding provider.
 */
export function fakeEmbed(dims: number): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const hash = createHash('sha256').update(text).digest('hex');
    const vec = Array.from({ length: dims }, (_, i) => {
      const offset = (i % 32) * 2;
      return parseInt(hash.slice(offset, offset + 2), 16) / 255;
    });
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  };
}
