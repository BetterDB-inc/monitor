#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));

const expectIndex = process.argv.indexOf('--expect');
const expected =
  expectIndex === -1 ? readJson('packages/mcp/package.json').version : process.argv[expectIndex + 1];

if (!expected) {
  console.error('Missing version after --expect');
  process.exit(1);
}

const server = readJson('packages/mcp/server.json');
const plugin = readJson('packages/mcp/claude-plugin/.claude-plugin/plugin.json');
const pluginMcp = readJson('packages/mcp/claude-plugin/.mcp.json');
const pinnedArg = pluginMcp.mcpServers.betterdb.args.find((arg) => arg.startsWith('@betterdb/mcp@'));

const found = [
  ['packages/mcp/package.json version', readJson('packages/mcp/package.json').version],
  ['packages/mcp/server.json version', server.version],
  ['packages/mcp/server.json packages[0].version', server.packages[0].version],
  ['packages/mcp/claude-plugin/.claude-plugin/plugin.json version', plugin.version],
  ['packages/mcp/claude-plugin/.mcp.json @betterdb/mcp pin', pinnedArg?.slice('@betterdb/mcp@'.length)],
];

const mismatches = found.filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  console.error(`@betterdb/mcp versions must all be ${expected}:`);
  for (const [where, version] of mismatches) {
    console.error(`  ${where}: ${version ?? 'missing'}`);
  }
  process.exit(1);
}

console.log(`@betterdb/mcp versions match ${expected}`);
