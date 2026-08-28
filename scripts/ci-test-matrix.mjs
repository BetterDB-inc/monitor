#!/usr/bin/env node
/**
 * Builds the CI test matrix from the workspace itself, so a new package with a
 * test suite is picked up without editing a workflow.
 *
 * Emits two GitHub Actions outputs, `node_matrix` and `python_matrix`, each a
 * JSON array of matrix entries for the suites a pull request needs to run.
 *
 * Usage:
 *   node scripts/ci-test-matrix.mjs --base <sha>   select suites affected by the diff
 *   node scripts/ci-test-matrix.mjs --all          select every suite
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Suites that already have a dedicated job in api-tests.yml. */
const DEDICATED_JOB_PACKAGES = new Set(['api', '@app/entitlement', '@betterdb/ai', 'betterdb-ai']);

/** Optional-dependency groups installed for a Python suite when it declares them. */
const PYTHON_EXTRAS = ['dev', 'langchain', 'langgraph'];

/** Cluster suites need a running cluster, so they run only in the cluster job. */
const CLUSTER_SUITE_EXCLUSION = "-- --exclude '**/*.cluster.integration.test.ts'";

/** Paths that cannot change the outcome of any test. */
const INERT_PATHS = [/^docs\//, /\.md$/];

function workspaceGlobs() {
  const raw = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;

  for (const line of raw.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages === false) {
      continue;
    }
    if (line.trim() !== '' && /^\S/.test(line)) {
      inPackages = false;
      continue;
    }
    const entry = line.match(/^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (entry !== null) {
      globs.push(entry[1]);
    }
  }

  return globs;
}

function expandGlob(glob) {
  if (glob.endsWith('/*') === false) {
    return existsSync(join(ROOT, glob)) ? [glob] : [];
  }

  const base = glob.slice(0, -2);
  const baseDir = join(ROOT, base);
  if (existsSync(baseDir) === false) {
    return [];
  }

  const entries = readdirSync(baseDir).filter((entry) => {
    return statSync(join(baseDir, entry)).isDirectory();
  });

  return entries.map((entry) => {
    return `${base}/${entry}`;
  });
}

function workspaceDirs() {
  const dirs = [];
  for (const glob of workspaceGlobs()) {
    dirs.push(...expandGlob(glob));
  }
  return dirs;
}

function discoverNodePackages() {
  const found = [];

  for (const dir of workspaceDirs()) {
    const manifestPath = join(ROOT, dir, 'package.json');
    if (existsSync(manifestPath) === false) {
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const ranges = { ...manifest.dependencies, ...manifest.devDependencies };
    const deps = Object.entries(ranges)
      .filter(([, range]) => {
        return String(range).startsWith('workspace:');
      })
      .map(([name]) => {
        return name;
      });

    found.push({
      name: manifest.name,
      dir,
      runner: 'node',
      deps,
      testScript: manifest.scripts?.test ?? null,
      hasTests: typeof manifest.scripts?.test === 'string',
    });
  }

  return found;
}

function tomlProjectName(raw) {
  const match = raw.match(/^name\s*=\s*"([^"]+)"/m);
  return match === null ? null : match[1];
}

function tomlDependencies(raw) {
  const block = raw.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (block === null) {
    return [];
  }

  const quoted = block[1].match(/"([^"]+)"/g) ?? [];
  return quoted.map((entry) => {
    return entry.slice(1, -1).split(/[<>=!~[\s]/)[0];
  });
}

function tomlExtras(raw) {
  const section = raw.match(/^\[project\.optional-dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
  if (section === null) {
    return [];
  }

  const keys = section[1].match(/^(\w+)\s*=\s*\[/gm) ?? [];
  return keys.map((entry) => {
    return entry.split('=')[0].trim();
  });
}

function discoverPythonPackages() {
  const found = [];

  for (const dir of workspaceDirs()) {
    const pyprojectPath = join(ROOT, dir, 'pyproject.toml');
    if (existsSync(pyprojectPath) === false) {
      continue;
    }

    const raw = readFileSync(pyprojectPath, 'utf8');
    const name = tomlProjectName(raw);
    if (name === null) {
      continue;
    }

    found.push({
      name,
      dir,
      runner: 'python',
      deps: tomlDependencies(raw),
      extras: tomlExtras(raw).filter((extra) => {
        return PYTHON_EXTRAS.includes(extra);
      }),
      hasTests: existsSync(join(ROOT, dir, 'tests')),
    });
  }

  return found;
}

function localDependencyChain(pkg, byName, seen = new Set()) {
  const chain = [];

  for (const depName of pkg.deps) {
    const dep = byName.get(depName);
    if (dep === undefined || seen.has(depName)) {
      continue;
    }
    seen.add(depName);
    chain.push(...localDependencyChain(dep, byName, seen), dep);
  }

  return chain;
}

function pythonInstallCommand(pkg, byName) {
  const chain = localDependencyChain(pkg, byName);
  const args = chain.map((dep) => {
    return `-e ${dep.dir}`;
  });

  if (pkg.extras.length > 0) {
    args.push(`-e "${pkg.dir}[${pkg.extras.join(',')}]"`);
  } else {
    args.push(`-e ${pkg.dir}`);
  }

  return `pip install ${args.join(' ')}`;
}

function changedPaths(base) {
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  return stdout.split('\n').filter((line) => {
    return line.trim() !== '';
  });
}

function owningDir(path, dirs) {
  let owner = null;

  for (const dir of dirs) {
    if (path.startsWith(`${dir}/`) === false) {
      continue;
    }
    if (owner === null || dir.length > owner.length) {
      owner = dir;
    }
  }

  return owner;
}

function isInert(path) {
  return INERT_PATHS.some((pattern) => {
    return pattern.test(path);
  });
}

function selectDirectly(paths, packages) {
  const dirs = packages.map((pkg) => {
    return pkg.dir;
  });
  const selected = new Set();

  for (const path of paths) {
    const owner = owningDir(path, dirs);
    if (owner !== null) {
      for (const pkg of packages) {
        if (pkg.dir === owner) {
          selected.add(pkg.name);
        }
      }
      continue;
    }
    if (isInert(path) === false) {
      return null;
    }
  }

  return selected;
}

function withDependents(selected, packages) {
  const result = new Set(selected);
  let grew = true;

  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (result.has(pkg.name)) {
        continue;
      }
      const dependsOnSelected = pkg.deps.some((dep) => {
        return result.has(dep);
      });
      if (dependsOnSelected) {
        result.add(pkg.name);
        grew = true;
      }
    }
  }

  return result;
}

function toMatrix(packages, selected, byName) {
  return packages
    .filter((pkg) => {
      if (pkg.hasTests === false) {
        return false;
      }
      if (DEDICATED_JOB_PACKAGES.has(pkg.name)) {
        return false;
      }
      return selected.has(pkg.name);
    })
    .map((pkg) => {
      const entry = { name: pkg.name, dir: pkg.dir, label: pkg.dir.split('/').pop() };
      if (pkg.runner === 'python') {
        entry.install = pythonInstallCommand(pkg, byName);
        return entry;
      }
      entry.testArgs = pkg.testScript.includes('vitest') ? CLUSTER_SUITE_EXCLUSION : '';
      return entry;
    })
    .sort((a, b) => {
      return a.label.localeCompare(b.label);
    });
}

function parseArgs(argv) {
  const envBase = process.env.BASE_SHA;
  const options = { all: false, base: envBase === undefined || envBase === '' ? null : envBase };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--all') {
      options.all = true;
      continue;
    }
    if (argv[i] === '--base') {
      options.base = argv[i + 1] ?? null;
      i += 1;
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const nodePackages = discoverNodePackages();
  const pythonPackages = discoverPythonPackages();
  const allPackages = [...nodePackages, ...pythonPackages];
  const byName = new Map(
    allPackages.map((pkg) => {
      return [pkg.name, pkg];
    }),
  );

  let selected;
  let reason;

  if (options.all === true || options.base === null) {
    selected = new Set(
      allPackages.map((pkg) => {
        return pkg.name;
      }),
    );
    reason = options.all === true ? 'requested every suite' : 'no diff base given';
  } else {
    const paths = changedPaths(options.base);
    const direct = selectDirectly(paths, allPackages);
    if (direct === null) {
      selected = new Set(
        allPackages.map((pkg) => {
          return pkg.name;
        }),
      );
      reason = 'a change outside every package can affect any suite';
    } else {
      selected = withDependents(direct, allPackages);
      reason = `${paths.length} changed file(s) against ${options.base}`;
    }
  }

  const nodeMatrix = toMatrix(nodePackages, selected, byName);
  const pythonMatrix = toMatrix(pythonPackages, selected, byName);

  console.log(`Selection: ${reason}`);
  console.log(`Node suites (${nodeMatrix.length}):`);
  for (const entry of nodeMatrix) {
    console.log(`  ${entry.label} — ${entry.name}`);
  }
  console.log(`Python suites (${pythonMatrix.length}):`);
  for (const entry of pythonMatrix) {
    console.log(`  ${entry.label} — ${entry.name}`);
  }

  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `node_matrix=${JSON.stringify(nodeMatrix)}\npython_matrix=${JSON.stringify(pythonMatrix)}\n`,
    );
  }
}

main();
