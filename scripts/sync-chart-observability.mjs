#!/usr/bin/env node
/**
 * Copies the observability pack into the Helm chart.
 *
 * Helm can only package files that live inside the chart directory, so the
 * chart carries byte-identical copies of:
 *
 *   deploy/observability/dashboards/*.json  ->  charts/betterdb-monitor/dashboards/
 *   docs/alertmanager-rules.yml             ->  charts/betterdb-monitor/files/alert-rules.yaml
 *
 * The files outside the chart stay the source of truth (the docker-compose
 * demo, the live demo and the docs all read them). Edit those, then re-run
 * this script. CI fails when a copy is stale, missing, or has no source.
 *
 *   node scripts/sync-chart-observability.mjs          refresh the chart copies
 *   node scripts/sync-chart-observability.mjs --check  exit 1 if they drifted
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'charts/betterdb-monitor');
const dashboardSourceDir = resolve(repoRoot, 'deploy/observability/dashboards');
const dashboardTargetDir = resolve(chartDir, 'dashboards');

function jsonFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()
    : [];
}

/** Every copy the chart must hold, as [source, target] absolute paths. */
export function expectedCopies() {
  return [
    ...jsonFiles(dashboardSourceDir).map((file) => [
      join(dashboardSourceDir, file),
      join(dashboardTargetDir, file),
    ]),
    [resolve(repoRoot, 'docs/alertmanager-rules.yml'), resolve(chartDir, 'files/alert-rules.yaml')],
  ];
}

/** Chart dashboards that no longer have a source dashboard. */
function orphanedDashboards() {
  const sources = new Set(jsonFiles(dashboardSourceDir));
  return jsonFiles(dashboardTargetDir)
    .filter((file) => !sources.has(file))
    .map((file) => join(dashboardTargetDir, file));
}

const rel = (path) => relative(repoRoot, path);

if (process.argv.includes('--check')) {
  const problems = [];
  for (const [source, target] of expectedCopies()) {
    if (!existsSync(target)) {
      problems.push(`${rel(target)} is missing (copy of ${rel(source)})`);
    } else if (!readFileSync(source).equals(readFileSync(target))) {
      problems.push(`${rel(target)} differs from ${rel(source)}`);
    }
  }
  for (const orphan of orphanedDashboards()) {
    problems.push(`${rel(orphan)} has no source in ${rel(dashboardSourceDir)}`);
  }
  if (problems.length > 0) {
    console.error('Helm chart observability copies are out of date:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Run: node scripts/sync-chart-observability.mjs');
    process.exit(1);
  }
  console.log('Helm chart observability copies are in sync.');
} else {
  for (const [source, target] of expectedCopies()) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  for (const orphan of orphanedDashboards()) {
    rmSync(orphan);
  }
  console.log(`Synced ${expectedCopies().length} file(s) into ${rel(chartDir)}.`);
}
