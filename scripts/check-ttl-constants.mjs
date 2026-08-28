#!/usr/bin/env node
/**
 * Guards the canonical TTL bounds against mirror drift.
 *
 * @betterdb/shared is private and never published, so @betterdb/semantic-cache,
 * @betterdb/mcp and the betterdb-semantic-cache wheel cannot import the
 * canonical constants — each keeps a mirror. This script reads the declared
 * value out of every one as source text, which is what lets a single check
 * cover TypeScript and Python alike with no build, no install and no test
 * runner in any package.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL = {
  label: 'canonical',
  file: 'packages/shared/src/utils/cache-proposals.ts',
  syntax: 'ts',
};

const MIRRORS = [
  { label: 'mirror', file: 'packages/semantic-cache/src/constants.ts', syntax: 'ts' },
  { label: 'mirror', file: 'packages/mcp/src/constants.ts', syntax: 'ts' },
  {
    label: 'mirror',
    file: 'packages/semantic-cache-py/betterdb_semantic_cache/constants.py',
    syntax: 'py',
  },
];

const NAMES = ['TTL_SECONDS_MIN', 'TTL_SECONDS_MAX'];

function declarationPattern(name, syntax) {
  if (syntax === 'py') {
    return new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'm');
  }
  return new RegExp(`^export const ${name}\\s*=\\s*(\\d+)\\s*;\\s*$`, 'm');
}

function readDeclarations(site, problems) {
  const path = join(repoRoot, site.file);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    problems.push(`${site.file}: cannot be read (${err.message})`);
    return null;
  }

  const values = {};
  for (const name of NAMES) {
    const match = declarationPattern(name, site.syntax).exec(source);
    if (match === null) {
      problems.push(`${site.file}: no ${name} declaration found`);
      continue;
    }
    values[name] = Number(match[1]);
  }
  return values;
}

function main() {
  const problems = [];
  const canonical = readDeclarations(CANONICAL, problems);

  const mirrors = MIRRORS.map((site) => {
    return { site, values: readDeclarations(site, problems) };
  });

  if (canonical !== null) {
    for (const { site, values } of mirrors) {
      if (values === null) {
        continue;
      }
      for (const name of NAMES) {
        if (values[name] === undefined || canonical[name] === undefined) {
          continue;
        }
        if (values[name] !== canonical[name]) {
          problems.push(
            `${name} has drifted:\n` +
              `    ${CANONICAL.file} declares ${canonical[name]}\n` +
              `    ${site.file} declares ${values[name]}`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error('TTL constant guard failed:\n');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(
      `\nEvery mirror must match ${CANONICAL.file}. Update all of them in the same commit.`,
    );
    process.exit(1);
  }

  const summary = NAMES.map((name) => {
    return `${name}=${canonical[name]}`;
  }).join(' ');
  console.log(`TTL constant guard passed: ${summary} across ${MIRRORS.length + 1} declarations.`);
}

main();
