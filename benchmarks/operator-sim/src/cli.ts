import { loadConfig } from './config.js';
import { helmUpgrade } from './infra/helm.js';
import { kindUp } from './infra/kind.js';
import { clusterUp, operatorUp, renderValkeyCluster } from './infra/valkey.js';
import { betterdbUp } from './infra/betterdb.js';
import { down, reset } from './infra/lifecycle.js';
import { verifyBetterdb } from './betterdb/verify.js';
import { runHarnessJob } from './infra/harness.js';
import { steadyState } from './load/steady.js';
import { prospect } from './report/prospect.js';
import { report } from './report/report.js';
import { runScenario } from './scenario/runner.js';
import { truthCollect, truthStart, truthStop } from './truth/deploy.js';
import { verifyCluster } from './infra/verify.js';
import { kubectl } from './k8s.js';

const ROOT = new URL('..', import.meta.url).pathname;

const commands: Record<string, (cfg: ReturnType<typeof loadConfig>) => Promise<void>> = {
  async 'kind-up'(cfg) {
    await kindUp(cfg, `${ROOT}infra/kind/cluster.yaml`);
    await helmUpgrade(cfg, 'metrics-server', 'metricsServer', 'kube-system', ['-f', `${ROOT}infra/metrics-server/values.yaml`]);
  },
  async 'chaos-up'(cfg) {
    await helmUpgrade(cfg, 'chaos-mesh', 'chaosMesh', cfg.chaos.namespace, ['-f', `${ROOT}infra/chaos-mesh/values.yaml`]);
  },
  async 'operator-up'(cfg) {
    await operatorUp(cfg);
  },
  async 'cluster-up'(cfg) {
    await clusterUp(cfg);
  },
  async betterdb(cfg) {
    await betterdbUp(cfg);
  },
  async 'verify-betterdb'(cfg) {
    if (!(await verifyBetterdb(cfg))) process.exit(1);
  },
  async warm(cfg) {
    const out = await runHarnessJob(cfg, 'warm', ['warm']);
    console.log(out.split('\n').filter((l) => !/"done":\d/.test(l)).join('\n'));
  },
  async load(cfg) {
    const checks = await steadyState(cfg, `${ROOT}runs/load-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (checks.some(([, ok]) => !ok)) process.exit(1);
  },
  // Collector check: run it for truth.smokeSec and copy the file back.
  async 'truth-smoke'(cfg) {
    const dir = `${ROOT}runs/truth-smoke`;
    await import('node:fs').then((fs) => fs.mkdirSync(dir, { recursive: true }));
    await truthStart(cfg, 'smoke');
    await new Promise((r) => setTimeout(r, cfg.truth.smokeSec * 1000));
    await truthCollect(cfg, `${dir}/groundtruth.jsonl`);
    await truthStop(cfg);
  },
  async report(cfg) {
    const run = process.env.RUN ?? (await import('node:fs')).readdirSync(`${ROOT}runs`).filter((d) => /^\d{4}-/.test(d)).sort().at(-1);
    if (!run) throw new Error('RUN=<id> required (no runs/ found)');
    await report(cfg, run);
  },
  // RUNS=<id>[,<id>…]: later runs supersede earlier ones phase by phase.
  async prospect(cfg) {
    if (!process.env.RUNS) throw new Error('RUNS=<run-id>[,<run-id>] required');
    await prospect(cfg, process.env.RUNS.split(','));
  },
  async reset(cfg) {
    await reset(cfg);
  },
  async down(cfg) {
    await down(cfg, process.env.KEEP_CLUSTER === '1');
  },
  async scenario(cfg) {
    await runScenario(cfg);
  },
  async 'verify-cluster'(cfg) {
    await verifyCluster(cfg);
  },
  async 'render-cluster'(cfg) {
    process.stdout.write(renderValkeyCluster(cfg));
  },
  async 'verify-kind'(cfg) {
    await kubectl(cfg, ['wait', '--for=condition=Ready', 'nodes', '--all', '--timeout=300s'], { stdio: 'inherit' });
    await kubectl(cfg, ['get', 'nodes', '-L', 'topology.kubernetes.io/zone'], { stdio: 'inherit' });
    // metrics-server needs a scrape cycle before `top` answers.
    for (let i = 0; ; i++) {
      const r = await kubectl(cfg, ['top', 'nodes'], { reject: false });
      if (r.exitCode === 0) { console.log(r.stdout); break; }
      if (i >= 30) throw new Error(`kubectl top never succeeded: ${r.stderr}`);
      await new Promise((res) => setTimeout(res, 5000));
    }
  },
};

const [cmd] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.error(`usage: sim <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
await fn(loadConfig());
