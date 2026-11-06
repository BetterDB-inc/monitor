#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(join(repoRoot, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const PACKAGE = '@betterdb/mcp';
const PIN_PATTERN = /@betterdb\/mcp@([0-9][0-9A-Za-z.+-]*)/g;
const UNPINNED_PATTERNS = [/npx(?:\s+(?:-y|--yes))?\s+@betterdb\/mcp(?![@\w/-])/g, /["']@betterdb\/mcp["']/g];
const PIN_DOCS = ['packages/mcp/README.md', 'packages/mcp/claude-plugin/README.md'];

const packageVersion = readJson('packages/mcp/package.json').version;
const server = readJson('packages/mcp/server.json');
const plugin = readJson('packages/mcp/claude-plugin/.claude-plugin/plugin.json');
const pluginArgs = readJson('packages/mcp/claude-plugin/.mcp.json').mcpServers.betterdb.args;
const pluginPin = pluginArgs.find((arg) => arg.startsWith(`${PACKAGE}@`))?.slice(PACKAGE.length + 1);

const packageExpected = argValue('--expect') ?? packageVersion;
const packageGroup = [
  ['packages/mcp/package.json version', packageVersion],
  ['packages/mcp/server.json version', server.version],
  ['packages/mcp/server.json packages[0].version', server.packages[0].version],
];

const pluginGroup = [
  ['packages/mcp/claude-plugin/.mcp.json pin', pluginPin],
  ['packages/mcp/claude-plugin/.claude-plugin/plugin.json version', plugin.version],
];
const problems = [];

for (const doc of PIN_DOCS) {
  const text = readText(doc);
  for (const match of text.matchAll(PIN_PATTERN)) {
    const line = text.slice(0, match.index).split('\n').length;
    pluginGroup.push([`${doc}:${line} pin`, match[1]]);
  }
  for (const pattern of UNPINNED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(`${doc}:${line} launches ${PACKAGE} without a version`);
    }
  }
}

for (const [where, version] of packageGroup) {
  if (version !== packageExpected) {
    problems.push(`${where} is ${version ?? 'missing'}, expected ${packageExpected}`);
  }
}

for (const [where, version] of pluginGroup) {
  if (version !== pluginPin) {
    problems.push(`${where} is ${version ?? 'missing'}, expected the plugin pin ${pluginPin}`);
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
