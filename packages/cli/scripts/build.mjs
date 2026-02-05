#!/usr/bin/env node

import { execSync } from 'child_process';
import { rmSync, mkdirSync, cpSync, existsSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..');
const monorepoRoot = join(cliRoot, '..', '..');

const assetsDir = join(cliRoot, 'assets');
const serverDir = join(assetsDir, 'server');
const webDir = join(assetsDir, 'web');
const distDir = join(cliRoot, 'dist');

function log(message) {
  console.log(`\x1b[36m[build]\x1b[0m ${message}`);
}

function error(message) {
  console.error(`\x1b[31m[build]\x1b[0m ${message}`);
}

function exec(command, options = {}) {
  log(`Running: ${command}`);
  try {
    execSync(command, { stdio: 'inherit', cwd: monorepoRoot, ...options });
  } catch (e) {
    error(`Command failed: ${command}`);
    process.exit(1);
  }
}

async function build() {
  log('Starting BetterDB CLI build...');

  // Step 1: Clean assets directory
  log('Cleaning assets directory...');
  if (existsSync(assetsDir)) {
    rmSync(assetsDir, { recursive: true });
  }
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });

  // Clean dist directory
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true });
  }

  // Step 2: Build dependencies with turbo
  log('Building API and Web with turbo...');
  exec('pnpm turbo build --filter=api --filter=web --filter=@betterdb/shared');

  // Step 3: Prepare @proprietary packages without mutating root node_modules
  log('Preparing @proprietary packages...');
  const tempNodeModulesDir = setupProprietaryNodePath();

  // Step 4: Bundle API with ncc
  log('Bundling API with ncc...');
  const apiEntry = join(monorepoRoot, 'apps', 'api', 'dist', 'apps', 'api', 'src', 'main.js');

  if (!existsSync(apiEntry)) {
    error(`API entry not found at ${apiEntry}`);
    error('Make sure the API was built successfully');
    process.exit(1);
  }

  try {
    const nodePath = tempNodeModulesDir
      ? [tempNodeModulesDir, process.env.NODE_PATH].filter(Boolean).join(delimiter)
      : process.env.NODE_PATH;
    exec(
      `npx @vercel/ncc build "${apiEntry}" -o "${serverDir}" --minify --external better-sqlite3 --external pg-native`,
      { cwd: monorepoRoot, env: { ...process.env, NODE_PATH: nodePath } }
    );
  } finally {
    cleanupProprietaryNodePath(tempNodeModulesDir);
  }

  // Step 5: Copy web assets
  log('Copying web assets...');
  const webDistDir = join(monorepoRoot, 'apps', 'web', 'dist');

  if (!existsSync(webDistDir)) {
    error(`Web dist not found at ${webDistDir}`);
    error('Make sure the web app was built successfully');
    process.exit(1);
  }

  cpSync(webDistDir, webDir, { recursive: true });

  // Step 6: Compile CLI TypeScript
  log('Compiling CLI TypeScript...');
  exec('npx esbuild src/index.ts --bundle --platform=node --target=node20 --outfile=dist/index.js --external:@inquirer/prompts --external:commander --external:picocolors', { cwd: cliRoot });

  // Step 7: Generate build info
  log('Generating build info...');
  const packageJson = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf-8'));
  const buildInfo = {
    version: packageJson.version,
    buildDate: new Date().toISOString(),
    nodeVersion: process.version,
  };
  writeFileSync(join(assetsDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2));

  log('Build complete!');
  log(`Assets directory: ${assetsDir}`);
  log(`Server bundle: ${join(serverDir, 'index.js')}`);
  log(`Web assets: ${webDir}`);
}

function setupProprietaryNodePath() {
  const proprietaryDir = join(monorepoRoot, 'proprietary');
  const tempNodeModulesDir = join(cliRoot, '.tmp-node-modules');
  const nodeModulesDir = join(tempNodeModulesDir, '@proprietary');

  if (!existsSync(proprietaryDir)) {
    log('No proprietary directory found, skipping @proprietary setup');
    return null;
  }

  if (existsSync(tempNodeModulesDir)) {
    rmSync(tempNodeModulesDir, { recursive: true });
  }
  mkdirSync(nodeModulesDir, { recursive: true });

  // Get all packages in proprietary directory (excluding 'ai')
  const packages = readdirSync(proprietaryDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .filter(dirent => dirent.name !== 'ai') // Exclude AI module
    .map(dirent => dirent.name);

  for (const pkg of packages) {
    const sourcePath = join(proprietaryDir, pkg);
    const targetPath = join(nodeModulesDir, pkg);

    // Check if package.json exists to validate it's a package
    if (!existsSync(join(sourcePath, 'package.json'))) {
      continue;
    }

    // Remove existing symlink if it exists
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true });
    }

    try {
      symlinkSync(sourcePath, targetPath, 'junction');
      log(`Created symlink: @proprietary/${pkg}`);
    } catch (e) {
      // Symlink might fail on some systems, try copy instead
      log(`Symlink failed, copying @proprietary/${pkg}`);
      cpSync(sourcePath, targetPath, { recursive: true });
    }
  }

  return tempNodeModulesDir;
}

function cleanupProprietaryNodePath(tempNodeModulesDir) {
  if (!tempNodeModulesDir) {
    return;
  }

  try {
    rmSync(tempNodeModulesDir, { recursive: true });
  } catch (e) {
    log('Failed to clean up temporary @proprietary node_modules');
  }
}

build().catch((e) => {
  error(e.message);
  process.exit(1);
});
