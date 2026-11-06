#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(join(repoRoot, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const PACKAGE = '@betterdb/mcp';
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const PIN_PATTERN = /@betterdb\/mcp@([^\s"'`)\]},]*)/g;
const UNPINNED_PATTERNS = [
  /npx(?:\s+(?:-y|--yes))?\s+@betterdb\/mcp(?![@\w/-])/g,
  /["']@betterdb\/mcp["']/g,
];
const SCANNED_FILES = ['README.md', 'packages/mcp/README.md', 'packages/mcp/claude-plugin/README.md'];
const SCANNED_DIRS = [
  { dir: 'docs', extensions: ['.md'] },
  { dir: 'apps/web/src', extensions: ['.ts', '.tsx'] },
];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

function walk(dir, extensions, found = []) {
  for (const name of readdirSync(join(repoRoot, dir))) {
    const path = join(dir, name);
    if (statSync(join(repoRoot, path)).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) walk(path, extensions, found);
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

const problems = [];

const expectIndex = process.argv.indexOf('--expect');
let packageExpected;
if (expectIndex !== -1) {
  packageExpected = process.argv[expectIndex + 1];
  if (!packageExpected || packageExpected.startsWith('--')) {
    console.error('--expect needs a version');
    process.exit(1);
  }
}

const packageVersion = readJson('packages/mcp/package.json').version;
const server = readJson('packages/mcp/server.json');
packageExpected ??= packageVersion;
const packageGroup = [
  ['packages/mcp/package.json version', packageVersion],
  ['packages/mcp/server.json version', server.version],
  ['packages/mcp/server.json packages[0].version', server.packages[0].version],
];
for (const [where, version] of packageGroup) {
  if (version !== packageExpected) {
    problems.push(`${where} is ${version ?? 'missing'}, expected ${packageExpected}`);
  }
}

const pluginArgs = readJson('packages/mcp/claude-plugin/.mcp.json').mcpServers.betterdb.args;
const pluginArg = pluginArgs.find((arg) => arg.startsWith(PACKAGE));
const pluginPin = pluginArg?.startsWith(`${PACKAGE}@`) ? pluginArg.slice(PACKAGE.length + 1) : undefined;
if (!pluginPin || !EXACT_VERSION.test(pluginPin)) {
  problems.push(
    `packages/mcp/claude-plugin/.mcp.json launches ${pluginArg ?? 'no package'}, expected an exact ${PACKAGE} version`,
  );
}

const files = [
  ...SCANNED_FILES,
  ...SCANNED_DIRS.flatMap(({ dir, extensions }) => walk(dir, extensions)),
].map((path) => relative(repoRoot, join(repoRoot, path)));

for (const file of files) {
  const text = readText(file);
  for (const match of text.matchAll(PIN_PATTERN)) {
    const where = `${file}:${lineOf(text, match.index)}`;
    if (!EXACT_VERSION.test(match[1])) {
      problems.push(`${where} pins ${PACKAGE}@${match[1]}, expected an exact version`);
    } else if (match[1] !== pluginPin) {
      problems.push(`${where} pins ${PACKAGE}@${match[1]}, expected the plugin pin ${pluginPin}`);
    }
  }
  for (const pattern of UNPINNED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      problems.push(`${file}:${lineOf(text, match.index)} launches ${PACKAGE} without a version`);
    }
  }
}

if (process.argv.includes('--check-published') && pluginPin) {
  try {
    execFileSync('npm', ['view', `${PACKAGE}@${pluginPin}`, 'version'], { stdio: 'pipe' });
  } catch {
    problems.push(`${PACKAGE}@${pluginPin} is pinned by the plugin but is not published on npm`);
  }
}

if (problems.length > 0) {
  console.error(`${PACKAGE} version check failed:`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log(`${PACKAGE} package is ${packageExpected}; plugin and docs pin ${pluginPin}`);
