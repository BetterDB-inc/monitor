/**
 * Mock embedder for demonstration purposes ONLY.
 *
 * HOW IT WORKS:
 * Tokens (words) from the input text are hashed to dimensions in a 128-dim
 * vector space. The result is L2-normalised. Two texts with more shared words
 * produce lower cosine distance (more similar).
 *
 * THIS IS NOT SEMANTIC SIMILARITY.
 * "France capital budget 2024" will score close to "What is the capital of France?"
 * because they share the words "france" and "capital" — even though they mean
 * different things. A real embedding model would score these as dissimilar.
 *
 * USE THIS FOR:
 * - Verifying the cache pipeline works (connect, store, retrieve, stats)
 * - Running the example without an API key
 * - CI/CD integration tests
 *
 * DO NOT USE THIS FOR:
 * - Evaluating cache hit rates or threshold values
 * - Benchmarking semantic cache effectiveness
 * - Any production use
 */

const DIM = 128;

export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'us', 'was', 'we', 'what', 'when', 'where',
  'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

/** Hash a string to an integer in [0, max). djb2 variant. */
function hashToIndex(s: string, max: number): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h % max;
}

/** Tokenise: lowercase, strip punctuation, split on whitespace, remove stop words. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** L2-normalise a vector in place. Returns the vector. */
function normalise(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export async function mockEmbed(text: string): Promise<number[]> {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = tokenise(text);
  if (tokens.length === 0) return normalise(vec);

  for (const token of tokens) {
    // Primary dimension for the token
    const primary = hashToIndex(token, DIM);
    vec[primary] += 1;

    // Secondary dimension for bigram context (token + length hash).
    // Helps distinguish "capital France" from "capital Germany".
    const secondary = hashToIndex(token + token.length.toString(), DIM);
    vec[secondary] += 0.5;
  }

  return normalise(vec);
}
