#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineAt, sourceFiles } from './lib/source-files.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(join(repoRoot, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const PACKAGE = '@betterdb/mcp';
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-\w+(?:\.\w+)*)?`;
const EXACT_VERSION = new RegExp(`^${SEMVER}$`);
const PIN_PATTERN = new RegExp(String.raw`@betterdb\/mcp@(${SEMVER}(?![\w.-]\w)|[^\s"'\x60)\]},]*)`, 'g');
const UNPINNED_PATTERNS = [
  /\b(?:npx|bunx|dlx|exec)(?:[ \t]+-{1,2}[\w-]+)*(?:[ \t]+|=)@betterdb\/mcp(?![@\w/-])/g,
  /["']@betterdb\/mcp["']/g,
];
const SCANNED_FILES = ['README.md', 'packages/mcp/README.md', 'packages/mcp/claude-plugin/README.md'];
const SCANNED_DIRS = [
  { dir: 'docs', extensions: ['.md', '.mdx'] },
  { dir: 'apps/web/src', extensions: ['.ts', '.tsx'] },
];
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${flag} needs a value`);
    process.exit(1);
  }
  return value;
}

function pinOf(mcpJson) {
  const arg = mcpJson.mcpServers.betterdb.args.find((value) => value.startsWith(PACKAGE));
  return { arg, pin: arg?.startsWith(`${PACKAGE}@`) ? arg.slice(PACKAGE.length + 1) : undefined };
}

function changedSince(ref, path) {
  return execFileSync('git', ['diff', '--name-only', ref, '--', path], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function readAtRef(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return undefined;
  }
}

const problems = [];

let packageExpected = argValue('--expect');
const baseRef = argValue('--base');

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

const PLUGIN_MCP = 'packages/mcp/claude-plugin/.mcp.json';
const PLUGIN_DIR = 'packages/mcp/claude-plugin';
const PLUGIN_MANIFEST = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
const { arg: pluginArg, pin: pluginPin } = pinOf(readJson(PLUGIN_MCP));
if (!pluginPin || !EXACT_VERSION.test(pluginPin)) {
  problems.push(
    `packages/mcp/claude-plugin/.mcp.json launches ${pluginArg ?? 'no package'}, expected an exact ${PACKAGE} version`,
  );
}

if (baseRef) {
  const baseManifest = readAtRef(baseRef, PLUGIN_MANIFEST);
  if (baseManifest) {
    const baseVersion = JSON.parse(baseManifest).version;
    const changed = changedSince(baseRef, PLUGIN_DIR);
    if (changed.length > 0 && baseVersion === readJson(PLUGIN_MANIFEST).version) {
      problems.push(
        `${PLUGIN_DIR} changed (${changed.join(', ')}) but ${PLUGIN_MANIFEST} version is still ${baseVersion}`,
      );
    }
  }
}

const files = [
  ...SCANNED_FILES,
  ...SCANNED_DIRS.flatMap(({ dir, extensions }) => sourceFiles(join(repoRoot, dir), extensions)),
].map((path) => relative(repoRoot, resolve(repoRoot, path)));

for (const file of files) {
  const text = readText(file);
  for (const match of text.matchAll(PIN_PATTERN)) {
    const where = `${file}:${lineAt(text, match.index)}`;
    if (!EXACT_VERSION.test(match[1])) {
      problems.push(`${where} pins ${PACKAGE}@${match[1]}, expected an exact version`);
    } else if (match[1] !== pluginPin) {
      problems.push(`${where} pins ${PACKAGE}@${match[1]}, expected the plugin pin ${pluginPin}`);
    }
  }
  for (const pattern of UNPINNED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      problems.push(`${file}:${lineAt(text, match.index)} launches ${PACKAGE} without a version`);
    }
  }
}

if (process.argv.includes('--check-published') && pluginPin) {
  try {
    execFileSync('npm', ['view', `${PACKAGE}@${pluginPin}`, 'version', '--json'], { stdio: 'pipe' });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    problems.push(
      output.includes('E404')
        ? `${PACKAGE}@${pluginPin} is pinned by the plugin but is not published on npm`
        : `could not check ${PACKAGE}@${pluginPin} on npm: ${output.trim() || error.message}`,
    );
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
