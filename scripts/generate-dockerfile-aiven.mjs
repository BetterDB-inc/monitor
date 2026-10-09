#!/usr/bin/env node
/**
 * Generates Dockerfile.aiven from Dockerfile.
 *
 * The Aiven Runtime build is the published Dockerfile minus the
 * telemetry/version build ARGs, which a from-source Aiven build never fills
 * and which would otherwise show up as empty fields on Aiven's deploy screen.
 * Those blocks are wrapped in `# aiven:strip-begin` / `# aiven:strip-end` in
 * Dockerfile; everything else is copied verbatim so the two cannot drift.
 *
 *   node scripts/generate-dockerfile-aiven.mjs          rewrite Dockerfile.aiven
 *   node scripts/generate-dockerfile-aiven.mjs --check  exit 1 if it is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repoRoot, 'Dockerfile');
const targetPath = resolve(repoRoot, 'Dockerfile.aiven');

const BEGIN = /^# aiven:strip-begin\b/;
const END = /^# aiven:strip-end\b/;

const HEADER = `# ============================================
# Dockerfile.aiven — Aiven Runtime build variant
# ============================================
# GENERATED from ./Dockerfile by scripts/generate-dockerfile-aiven.mjs.
# Do not edit by hand: change ./Dockerfile and re-run the script. CI fails
# when this file is out of date.
#
# It omits the telemetry/version build ARGs (APP_VERSION, POSTHOG_API_KEY,
# POSTHOG_HOST, VITE_PUBLIC_POSTHOG_*, VITE_PUBLIC_APP_VERSION,
# VITE_REGISTRATION_URL), marked with aiven:strip-begin/end in ./Dockerfile.
# They only matter for the published betterdb/monitor image, where CI injects
# them at build time. On a from-source Aiven Runtime build they are never
# populated, so they would only show up as empty, confusing fields on Aiven's
# deploy screen. compose.aiven.yaml points its build at this file.

`;

export function generate(source) {
  const lines = source.split('\n');
  const kept = [];
  let stripping = false;
  let skipBlank = false;
  for (const [index, line] of lines.entries()) {
    if (BEGIN.test(line)) {
      if (stripping) throw new Error(`Dockerfile:${index + 1}: nested aiven:strip-begin`);
      stripping = true;
      continue;
    }
    if (END.test(line)) {
      if (!stripping) throw new Error(`Dockerfile:${index + 1}: aiven:strip-end without begin`);
      stripping = false;
      skipBlank = true;
      continue;
    }
    if (stripping) continue;
    if (skipBlank && line === '') {
      skipBlank = false;
      continue;
    }
    skipBlank = false;
    kept.push(line);
  }
  if (stripping) throw new Error('Dockerfile: aiven:strip-begin without end');
  return HEADER + kept.join('\n');
}

const expected = generate(readFileSync(sourcePath, 'utf8'));

if (process.argv.includes('--check')) {
  const actual = readFileSync(targetPath, 'utf8');
  if (actual !== expected) {
    console.error(
      'Dockerfile.aiven is out of date with Dockerfile. Run: node scripts/generate-dockerfile-aiven.mjs',
    );
    process.exit(1);
  }
  console.log('Dockerfile.aiven is up to date.');
} else {
  writeFileSync(targetPath, expected);
  console.log('Wrote Dockerfile.aiven.');
}
