import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { stringify } from 'yaml';
import type { SimConfig } from '../config.js';
import { kubectl, kubectlApply } from '../k8s.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const INPUTS = ['Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'config', 'src'];

function* files(p: string): Generator<string> {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) yield* files(join(p, e));
  else yield p;
}

// Content-addressed tag so a rebuild only happens when harness inputs change.
export function harnessImage(cfg: SimConfig) {
  const h = createHash('sha256');
  for (const i of INPUTS) for (const f of files(join(ROOT, i))) h.update(relative(ROOT, f)).update(readFileSync(f));
  return `${cfg.harness.imageRepo}:${h.digest('hex').slice(0, 12)}`;
}

export async function buildAndLoadHarness(cfg: SimConfig) {
  const image = harnessImage(cfg);
  const present = await execa('docker', ['image', 'inspect', image], { reject: false });
  if (present.exitCode !== 0) await execa('docker', ['build', '-t', image, ROOT], { stdio: 'inherit' });
  await execa('kind', ['load', 'docker-image', image, '--name', cfg.kind.clusterName], { stdio: 'inherit' });
  return image;
}

function jobManifest(cfg: SimConfig, image: string, name: string, args: string[], env: Record<string, string>) {
  const ns = cfg.harness.namespace;
  return stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: ns, labels: { app: 'operator-sim', job: name } },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { app: 'operator-sim', job: name } },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'sim', image, imagePullPolicy: 'Never', args,
            env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
          }],
        },
      },
    },
  });
}

// Start `incluster <cmd>` as a one-shot Job without waiting for it.
export async function startHarnessJob(cfg: SimConfig, name: string, args: string[], env: Record<string, string> = {}) {
  const image = await buildAndLoadHarness(cfg);
  const ns = cfg.harness.namespace;
  await kubectlApply(cfg, `apiVersion: v1\nkind: Namespace\nmetadata: { name: ${ns} }\n`);
  await deleteHarnessJob(cfg, name);
  await kubectlApply(cfg, jobManifest(cfg, image, name, args, env));
  await kubectl(cfg, ['-n', ns, 'wait', '--for=condition=Ready', 'pod', '-l', `job=${name}`, `--timeout=${cfg.harness.startTimeoutSec}s`], { reject: false });
}

export async function deleteHarnessJob(cfg: SimConfig, name: string) {
  await kubectl(cfg, ['-n', cfg.harness.namespace, 'delete', 'job', name, '--ignore-not-found', '--wait', '--cascade=foreground']);
}

// Block until the Job finishes; returns its logs. Throws on failure.
export async function waitHarnessJob(cfg: SimConfig, name: string, timeoutSec: number) {
  const ns = cfg.harness.namespace;
  const done = await kubectl(cfg, ['-n', ns, 'wait', '--for=jsonpath={.status.conditions[?(@.status=="True")].type}', `job/${name}`, `--timeout=${timeoutSec}s`], { reject: false });
  const logs = await kubectl(cfg, ['-n', ns, 'logs', `job/${name}`], { reject: false });
  const job = await kubectl(cfg, ['-n', ns, 'get', `job/${name}`, '-o', 'jsonpath={.status.succeeded}'], { reject: false });
  if (done.exitCode !== 0 || String(job.stdout) !== '1') throw new Error(`job ${name} did not succeed:\n${String(logs.stdout).slice(-2000)}\n${logs.stderr}`);
  return String(logs.stdout);
}

// Run `incluster <cmd>` as a one-shot Job, wait, return stdout.
export async function runHarnessJob(cfg: SimConfig, name: string, args: string[], env: Record<string, string> = {}, timeoutSec = cfg.harness.jobTimeoutSec) {
  await startHarnessJob(cfg, name, args, env);
  return waitHarnessJob(cfg, name, timeoutSec);
}
