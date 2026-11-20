#!/usr/bin/env node
/**
 * Bumps the app version everywhere a release commit has to change it.
 *
 *   - package.json, apps/api/package.json, apps/web/package.json: "version"
 *   - charts/betterdb-monitor/Chart.yaml: `version`, `appVersion` and both
 *     artifacthub.io/images tags (<v>-no-ai and <v>)
 *
 * The chart is released in lockstep with the app: chart version == appVersion
 * == app version. Pushing tag v<version> then builds the images and publishes
 * the chart (docker-publish.yml -> helm-publish.yml). Only the version fields
 * are rewritten; the rest of each file is left byte-for-byte as it was.
 * scripts/check-chart-version.sh verifies the result.
 *
 *   node scripts/bump-version.mjs 0.57.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGE_FILES = ['package.json', 'apps/api/package.json', 'apps/web/package.json'];
const CHART_FILE = 'charts/betterdb-monitor/Chart.yaml';

// SemVer 2.0.0, no build metadata (a `+` is not valid in a Docker tag).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const arg = process.argv[2];
if (!arg || process.argv.length > 3) {
  console.error('usage: node scripts/bump-version.mjs <X.Y.Z>');
  process.exit(2);
}
const version = arg.replace(/^v/, '');
if (!SEMVER.test(version)) {
  console.error(`"${arg}" is not a SemVer version (X.Y.Z or X.Y.Z-pre.1).`);
  process.exit(2);
}

/** Applies each [pattern, replacer] once; fails if a pattern does not match. */
function rewrite(file, edits) {
  const path = resolve(repoRoot, file);
  let text = readFileSync(path, 'utf8');
  for (const [pattern, replacement, what] of edits) {
    if (!pattern.test(text)) {
      console.error(`${file}: could not find ${what}`);
      process.exit(1);
    }
    text = text.replace(pattern, replacement);
  }
  writeFileSync(path, text);
  console.log(`${file} -> ${version}`);
}

for (const file of PACKAGE_FILES) {
  // The first "version" key is the package's own (top-level) version.
  rewrite(file, [[/("version"\s*:\s*")[^"]*(")/, (_, pre, post) => `${pre}${version}${post}`, 'the "version" field']]);
}

rewrite(CHART_FILE, [
  [/^version:.*$/m, `version: ${version}`, 'the top-level version'],
  [/^appVersion:.*$/m, `appVersion: "${version}"`, 'the top-level appVersion'],
  [
    /^([ \t]+image: betterdb\/monitor:)[^\s]+-no-ai$/m,
    (_, pre) => `${pre}${version}-no-ai`,
    'the betterdb/monitor:<v>-no-ai image annotation',
  ],
  [
    /^([ \t]+image: betterdb\/monitor:)(?![^\s]*-no-ai$)[^\s]+$/m,
    (_, pre) => `${pre}${version}`,
    'the betterdb/monitor:<v> image annotation',
  ],
]);
