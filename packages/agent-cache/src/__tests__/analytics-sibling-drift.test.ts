import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The serverless delivery logic in analytics.ts also ships as a copy in
 * agent-memory, retrieval and semantic-cache, but only this package exercises
 * it (analytics.test.ts). The copies intentionally diverge in their client
 * surface, event constants and deployment-id resolution, so whole-file
 * identity cannot hold; instead the shared regions — everything the
 * serverless tests cover — must stay byte-identical, which keeps those tests
 * honest for all four packages. Mirrors the inject-telemetry-defaults
 * sibling check.
 */

const SIBLINGS = ['agent-memory', 'retrieval', 'semantic-cache'];

interface SharedRegion {
  name: string;
  start: string;
  end: string;
}

const SHARED_REGIONS: SharedRegion[] = [
  {
    // NOOP fallback, opt-out, install id, waitUntil discovery,
    // frozen-serverless detection, the PostHogClient surface and the
    // constructor with its beforeExit flush backstop.
    name: 'core',
    start: 'export const NOOP_ANALYTICS',
    end: '  async init(\n',
  },
  {
    // capture plus the whole delivery path: deliver, registerSnapshot,
    // onActivity, snapshotTick, emitSnapshotIfDue, flush, shutdown and the
    // createAnalytics gating.
    name: 'delivery',
    start: '  capture(event: string, properties?: Record<string, unknown>): void {',
    end: '    // @ts-ignore',
  },
];

// init() itself diverges per package (client type, init event name), but its
// inline-flush tail is the serverless-critical part and must not drift.
const INIT_INLINE_FLUSH =
  '    if (!getRequestWaitUntil()) {\n      await this.flush();\n    }\n  }';

function readAnalytics(pkg: string): string {
  return readFileSync(resolve(__dirname, `../../../${pkg}/src/analytics.ts`), 'utf8');
}

function sliceRegion(source: string, region: SharedRegion, pkg: string): string {
  const start = source.indexOf(region.start);
  expect(start, `${pkg}: start marker for the ${region.name} region not found`).toBeGreaterThan(-1);
  const end = source.indexOf(region.end, start);
  expect(end, `${pkg}: end marker for the ${region.name} region not found`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('analytics.ts sibling drift', () => {
  const canonical = readAnalytics('agent-cache');

  it.each(SHARED_REGIONS)('the $name region stays byte-identical across siblings', (region) => {
    const expected = sliceRegion(canonical, region, 'agent-cache');

    for (const sibling of SIBLINGS) {
      const actual = sliceRegion(readAnalytics(sibling), region, sibling);
      expect(actual, `${sibling} analytics.ts drifted in the ${region.name} region`).toBe(expected);
    }
  });

  it('keeps the init inline-flush tail in every sibling', () => {
    expect(canonical).toContain(INIT_INLINE_FLUSH);

    for (const sibling of SIBLINGS) {
      expect(readAnalytics(sibling), `${sibling} lost the init inline flush`).toContain(
        INIT_INLINE_FLUSH,
      );
    }
  });
});
