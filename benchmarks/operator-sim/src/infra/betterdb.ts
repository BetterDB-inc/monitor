import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { stringify } from 'yaml';
import type { SimConfig } from '../config.js';
import { helm, kubectl, kubectlApply, kubectlJson } from '../k8s.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const MONITOR_REPO = join(ROOT, '../..');
const SRC_DIR = join(ROOT, '.bin', 'betterdb-src');

const git = (args: string[], cwd = MONITOR_REPO) => execa('git', args, { cwd }).then((r) => String(r.stdout).trim());

// betterdb.buildRef set → build that commit (detached worktree, never pushed), tag
// `<version>-<sha8>-no-ai`, load into kind. Unset → published betterdb.imageTag.
export async function betterdbImage(cfg: SimConfig): Promise<{ tag: string; pullPolicy: string; ref?: string; sha?: string }> {
  const ref = cfg.betterdb.buildRef;
  if (!ref) return { tag: cfg.betterdb.imageTag, pullPolicy: 'IfNotPresent' };
  const sha = await git(['rev-parse', '--short=8', `${ref}^{commit}`]);
  const version = JSON.parse(await git(['show', `${sha}:package.json`])).version as string;
  const tag = `${version}-${sha}-no-ai`;
  const image = `betterdb/monitor:${tag}`;
  if ((await execa('docker', ['image', 'inspect', image], { reject: false })).exitCode !== 0) {
    if (existsSync(SRC_DIR)) await git(['worktree', 'remove', '--force', SRC_DIR]);
    await git(['worktree', 'add', '--quiet', '--detach', SRC_DIR, sha]);
    await execa('docker', ['build', '--target', 'production-no-ai', '--build-arg', `APP_VERSION=${version}-${sha}`, '-t', image, SRC_DIR], { stdio: 'inherit' });
    await git(['worktree', 'remove', '--force', SRC_DIR]);
  }
  await execa('kind', ['load', 'docker-image', image, '--name', cfg.kind.clusterName], { stdio: 'inherit' });
  return { tag, pullPolicy: 'Never', ref, sha };
}
async function secretValue(cfg: SimConfig, ns: string, name: string, key: string) {
  const r = await kubectl(cfg, ['-n', ns, 'get', 'secret', name, '-o', `jsonpath={.data.${key.replace(/\./g, '\\.')}}`], { reject: false });
  return r.exitCode === 0 && r.stdout ? Buffer.from(String(r.stdout), 'base64').toString() : undefined;
}

function readDotEnv(): Record<string, string> {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return {};
  return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }));
}

const secretManifest = (ns: string, name: string, data: Record<string, string>) =>
  stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: ns }, type: 'Opaque', stringData: data });

// Passwords are generated once and reused (read back from the cluster) so re-runs are stable.
export async function ensureMonitorUserSecret(cfg: SimConfig) {
  const c = cfg.cluster;
  await kubectlApply(cfg, `apiVersion: v1\nkind: Namespace\nmetadata: { name: ${c.namespace} }\n`);
  const pw = (await secretValue(cfg, c.namespace, c.usersSecret, cfg.betterdb.valkeyUser)) ?? randomBytes(18).toString('base64url');
  await kubectlApply(cfg, secretManifest(c.namespace, c.usersSecret, { [cfg.betterdb.valkeyUser]: pw }));
  return pw;
}

export async function betterdbUp(cfg: SimConfig) {
  const ns = cfg.betterdb.namespace;
  const license = readDotEnv().BETTERDB_LICENSE_KEY ?? process.env.BETTERDB_LICENSE_KEY;
  if (!license) throw new Error('BETTERDB_LICENSE_KEY missing: put it in benchmarks/operator-sim/.env (gitignored)');

  const valkeyPw = await ensureMonitorUserSecret(cfg);
  await kubectlApply(cfg, `apiVersion: v1\nkind: Namespace\nmetadata: { name: ${ns} }\n`);
  const pgPw = (await secretValue(cfg, ns, 'betterdb-sim', 'pg-password')) ?? randomBytes(18).toString('base64url');
  const encKey = (await secretValue(cfg, ns, 'betterdb-sim', 'encryption-key')) ?? randomBytes(24).toString('base64url');
  const prevLicense = await secretValue(cfg, ns, 'betterdb-sim', 'license-key');
  await kubectlApply(cfg, secretManifest(ns, 'betterdb-sim', {
    'valkey-password': valkeyPw,
    'pg-password': pgPw,
    'storage-url': `postgresql://betterdb:${pgPw}@postgres.${ns}.svc.cluster.local:5432/betterdb`,
    'encryption-key': encKey,
    'license-key': license,
  }));

  await kubectlApply(cfg, readFileSync(join(ROOT, 'infra/betterdb/postgres.yaml'), 'utf8'));
  await kubectl(cfg, ['-n', ns, 'rollout', 'status', 'statefulset/postgres', '--timeout=300s'], { stdio: 'inherit' });

  const { tag, pullPolicy } = await betterdbImage(cfg);
  const chart = cfg.charts.betterdbMonitor!;
  // Seed = operator headless Service: resolves to every pod (PR #651 alias handling, v0.55.0).
  const seed = `valkey-${cfg.cluster.name}.${cfg.cluster.namespace}.svc.cluster.local`;
  await helm(cfg, [
    'upgrade', '--install', cfg.betterdb.release, chart.chart, '--repo', chart.repo, '--version', chart.version,
    '--namespace', ns, '-f', join(ROOT, 'infra/betterdb/values.yaml'),
    '--set', `image.tag=${tag}`, '--set', `image.pullPolicy=${pullPolicy}`, '--set', `db.host=${seed}`,
    '--wait', '--timeout', '10m',
  ], { stdio: 'inherit' });

  const svc = await kubectlJson(cfg, ['-n', ns, 'get', 'svc', '-l', `app.kubernetes.io/instance=${cfg.betterdb.release}`]);
  const selector = svc.items[0].spec.selector;
  await kubectlApply(cfg, stringify({
    apiVersion: 'v1', kind: 'Service', metadata: { name: `${cfg.betterdb.release}-nodeport`, namespace: ns },
    spec: { type: 'NodePort', selector, ports: [{ name: 'http', port: 3001, targetPort: 'http', nodePort: cfg.betterdb.nodePort }] },
  }));
  // Env from a Secret is read at container start; a new key needs a restart.
  if (prevLicense !== undefined && prevLicense !== license) {
    await kubectl(cfg, ['-n', ns, 'rollout', 'restart', `deploy/${cfg.betterdb.release}-betterdb-monitor`]);
    await kubectl(cfg, ['-n', ns, 'rollout', 'status', `deploy/${cfg.betterdb.release}-betterdb-monitor`, '--timeout=300s'], { stdio: 'inherit' });
  }
  await waitHealthy(cfg);
  console.log(`BetterDB ${tag} at ${cfg.betterdb.url}`);
}

export async function waitHealthy(cfg: SimConfig) {
  const deadline = Date.now() + cfg.betterdb.readyTimeoutSec * 1000;
  for (;;) {
    const ok = await fetch(new URL('/api/health', cfg.betterdb.url)).then((r) => r.ok, () => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${cfg.betterdb.url}/api/health not OK after ${cfg.betterdb.readyTimeoutSec}s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
