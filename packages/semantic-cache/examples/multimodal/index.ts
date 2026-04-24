/**
 * Multi-modal prompt caching example for @betterdb/semantic-cache
 *
 * Demonstrates:
 *   1. ContentBlock[] prompts with TextBlock and BinaryBlock
 *   2. Same text + same image -> cache hit
 *   3. Same text + different image -> cache miss
 *   4. storeMultipart() storing structured response blocks
 *
 * No API key required - uses a mock embedder with hardcoded vectors.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import {
  SemanticCache,
  hashBase64,
  type ContentBlock,
} from '@betterdb/semantic-cache';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

// Small 1x1 PNG images in base64 for demo purposes (no filesystem deps)
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
const BLUE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Mock embedder that maps text to fixed vectors
function mockEmbed(text: string): Promise<number[]> {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const dim = 8;
  const vec = new Array<number>(dim).fill(0);
  for (const word of words) {
    for (let i = 0; i < word.length && i < dim; i++) {
      vec[i] += word.charCodeAt(i) / 1000;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(vec.map((x) => x / norm));
}

const client = new Valkey({ host, port });

const cache = new SemanticCache({
  client,
  embedFn: mockEmbed,
  name: 'example_multimodal',
  defaultThreshold: 0.05,
  defaultTtl: 300,
});

function makeImagePrompt(text: string, imageB64: string): ContentBlock[] {
  return [
    { type: 'text', text },
    {
      type: 'binary',
      kind: 'image',
      mediaType: 'image/png',
      ref: hashBase64(imageB64),
    },
  ];
}

async function main() {
  console.log('=== Multi-modal caching example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  const prompt = 'Describe the color of this image.';

  // -- Store with RED image --
  console.log('-- Storing: "Describe the color..." + red image --');
  const redPrompt = makeImagePrompt(prompt, RED_PNG_B64);
  const redResponse: ContentBlock[] = [
    { type: 'text', text: 'The image is red.' },
  ];
  await cache.storeMultipart(redPrompt, redResponse);
  console.log('  Stored entry with red image.\n');

  // -- Check 1: Same text + same image -> HIT --
  console.log('-- Check 1: Same text + same image --');
  const check1 = await cache.check(makeImagePrompt(prompt, RED_PNG_B64));
  if (check1.hit) {
    console.log(`  HIT - response: "${check1.response}" | similarity: ${check1.similarity?.toFixed(4)}`);
    if (check1.contentBlocks) {
      console.log(`  Content blocks: ${JSON.stringify(check1.contentBlocks)}`);
    }
  } else {
    console.log('  MISS (unexpected)');
  }
  console.log();

  // -- Check 2: Same text + different image -> MISS --
  console.log('-- Check 2: Same text + different image (blue) --');
  const check2 = await cache.check(makeImagePrompt(prompt, BLUE_PNG_B64));
  if (check2.hit) {
    console.log('  HIT (unexpected - images should differ)');
  } else {
    console.log('  MISS - different image ref, no cache hit.');
  }
  console.log();

  // -- Check 3: Same text, no image --
  console.log('-- Check 3: Same text, no image (text-only) --');
  const check3 = await cache.check(prompt);
  if (check3.hit) {
    console.log('  HIT (text-only matched entry with image)');
  } else {
    console.log('  MISS - text-only prompt does not match image-tagged entry.');
  }
  console.log();

  // -- Stats --
  const stats = await cache.stats();
  console.log('-- Cache Stats --');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
