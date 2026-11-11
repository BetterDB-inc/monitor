import { stringify } from 'yaml';
import type { SimConfig } from '../config.js';
import { buildAndLoadHarness } from '../infra/harness.js';
import { kubectl, kubectlApply, kubectlJson } from '../k8s.js';
import { headlessHost, VALKEY_PORT } from '../valkey.js';

const APP = 'app-gen';
const MEMTIER = 'memtier';

// memtier 2.5.2 in-cluster (no port-forward bottleneck). --rate-limiting is per connection,
// so total ≈ clients × threads × ratePerConn. Writes JSON to an emptyDir; logs carry the
// periodic progress lines.
export function memtierArgs(cfg: SimConfig, testTimeSec: number) {
  const m = cfg.load.memtier;
  return [
    `--server=${headlessHost(cfg)}`, `--port=${VALKEY_PORT}`, '--cluster-mode',
    `--clients=${m.clients}`, `--threads=${m.threads}`, `--ratio=${m.ratio}`,
    `--key-pattern=${m.keyPattern}`, `--key-zipf-exp=${m.zipfExp}`, `--key-prefix=${m.keyPrefix}`, `--key-maximum=${m.keyMaximum}`,
    `--data-size-range=${m.dataSizeRange}`, `--rate-limiting=${m.ratePerConn}`, `--pipeline=${m.pipeline}`,
    `--test-time=${testTimeSec}`, '--reconnect-on-error', '--hide-histogram',
    `--json-out-file=/out/memtier.json`,
  ];
}

export async function memtierStart(cfg: SimConfig, testTimeSec: number) {
  const ns = cfg.harness.namespace;
  await kubectl(cfg, ['-n', ns, 'delete', 'job', MEMTIER, '--ignore-not-found', '--wait']);
  await kubectlApply(cfg, stringify({
    apiVersion: 'batch/v1', kind: 'Job', metadata: { name: MEMTIER, namespace: ns, labels: { app: MEMTIER } },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { app: MEMTIER } },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'memtier', image: cfg.load.memtier.image, command: ['sh', '-c'],
              // Keep the pod alive briefly after the run so the JSON can be copied out.
              args: [`memtier_benchmark ${memtierArgs(cfg, testTimeSec).join(' ')}; rc=$?; sleep ${cfg.load.memtier.collectGraceSec}; exit $rc`],
              resources: { requests: { cpu: cfg.load.memtier.cpu, memory: '64Mi' } },
              volumeMounts: [{ name: 'out', mountPath: '/out' }],
            },
          ],
          volumes: [{ name: 'out', emptyDir: {} }],
        },
      },
    },
  }));
}

export async function memtierCollect(cfg: SimConfig, dest: string) {
  const ns = cfg.harness.namespace;
  const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', ns, 'get', 'pods', '-l', `app=${MEMTIER}`]);
  const pod = pods.items[0]?.metadata.name;
  if (!pod) return false;
  const r = await kubectl(cfg, ['-n', ns, 'cp', '-c', 'memtier', `${pod}:/out/memtier.json`, dest], { reject: false });
  return r.exitCode === 0;
}

export async function appGenUp(cfg: SimConfig, rps = cfg.load.app.rps) {
  const ns = cfg.harness.namespace;
  const a = cfg.load.app;
  const image = await buildAndLoadHarness(cfg);
  await kubectlApply(cfg, `apiVersion: v1\nkind: Namespace\nmetadata: { name: ${ns} }\n`);
  await kubectlApply(cfg, stringify({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: APP, namespace: ns, labels: { app: APP } },
    spec: {
      replicas: a.replicas,
      selector: { matchLabels: { app: APP } },
      template: {
        metadata: { labels: { app: APP } },
        spec: {
          containers: [{
            name: 'sim', image, imagePullPolicy: 'Never', args: ['app-gen'],
            env: [
              { name: 'APP_REPLICAS', value: String(a.replicas) },
              { name: 'CONTROL_FILE', value: a.controlFile },
              { name: 'POD_SEED', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            ],
            resources: { requests: { cpu: a.cpu, memory: a.memory } },
            volumeMounts: [{ name: 'control', mountPath: a.controlFile.replace(/\/[^/]+$/, '') }],
          }],
          volumes: [{ name: 'control', emptyDir: {} }],
        },
      },
    },
  }));
  await kubectl(cfg, ['-n', ns, 'rollout', 'status', `deploy/${APP}`, '--timeout=180s'], { stdio: 'inherit' });
  await setAppRps(cfg, rps);
}

// Rewrite the control file in every app-gen pod; returns the wall-clock ms it took effect.
export async function setAppRps(cfg: SimConfig, rps: number) {
  const ns = cfg.harness.namespace;
  const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', ns, 'get', 'pods', '-l', `app=${APP}`, '--field-selector=status.phase=Running']);
  const body = JSON.stringify({ rps });
  // Skip pods a rollout is terminating; they are gone before the next tick anyway.
  await Promise.all(pods.items.filter((p) => !p.metadata.deletionTimestamp).map((p) => kubectl(cfg, ['-n', ns, 'exec', p.metadata.name, '--', 'sh', '-c', `printf '%s' '${body}' > ${cfg.load.app.controlFile}`])));
  return Date.now();
}

export async function appGenLogs(cfg: SimConfig, sinceTime?: string) {
  const ns = cfg.harness.namespace;
  const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', ns, 'get', 'pods', '-l', `app=${APP}`]);
  const out = await Promise.all(pods.items.map((p) => kubectl(cfg, ['-n', ns, 'logs', p.metadata.name, ...(sinceTime ? [`--since-time=${sinceTime}`] : [])], { reject: false }).then((r) => String(r.stdout))));
  return out.join('\n').split('\n').filter((l) => l.startsWith('{"ts"'));
}

// Waits for the pods to be gone: a terminating generator still writes for a few seconds.
export async function loadDown(cfg: SimConfig) {
  const ns = cfg.harness.namespace;
  await kubectl(cfg, ['-n', ns, 'delete', 'deploy', APP, '--ignore-not-found', '--wait']);
  await kubectl(cfg, ['-n', ns, 'delete', 'job', MEMTIER, '--ignore-not-found', '--wait', '--cascade=foreground']);
  await kubectl(cfg, ['-n', ns, 'wait', '--for=delete', 'pod', '-l', `app in (${APP},${MEMTIER})`, '--timeout=120s'], { reject: false });
}
