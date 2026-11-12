#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL = { file: 'apps/api/src/common/utils/env-bool.ts', name: 'NEGATIVE_ENV_VALUES' };
const MIRRORS = [{ file: 'packages/mcp/src/telemetry.ts', name: 'OFF_VALUES' }];

function readSet({ file, name }) {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  const match = text.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  if (!match) {
    console.error(`${file}: no ${name} set found`);
    process.exit(1);
  }
  return [...match[1].matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]).sort();
}

const canonical = readSet(CANONICAL);
let failed = false;
for (const mirror of MIRRORS) {
  const values = readSet(mirror);
  if (values.join() !== canonical.join()) {
    console.error(
      `${mirror.file} ${mirror.name} is [${values}], expected [${canonical}] from ${CANONICAL.file}`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Negative env values match ${CANONICAL.file}: [${canonical}]`);
