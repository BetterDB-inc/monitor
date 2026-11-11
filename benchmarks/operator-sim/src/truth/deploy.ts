import { stringify } from 'yaml';
import type { SimConfig } from '../config.js';
import { buildAndLoadHarness } from '../infra/harness.js';
import { kubectl, kubectlApply, kubectlJson } from '../k8s.js';

const NAME = 'truth';

// Read-only pod listing in the Valkey namespace, for pod → shard attribution.
function rbac(cfg: SimConfig) {
  const ns = cfg.harness.namespace;
  return [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: NAME, namespace: ns } },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: `${NAME}-pods`, namespace: cfg.cluster.namespace }, rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: `${NAME}-pods`, namespace: cfg.cluster.namespace }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: `${NAME}-pods` }, subjects: [{ kind: 'ServiceAccount', name: NAME, namespace: ns }] },
  ].map((o) => stringify(o)).join('---\n');
}

export async function truthStart(cfg: SimConfig, runId: string) {
  const ns = cfg.harness.namespace;
  const image = await buildAndLoadHarness(cfg);
  await kubectlApply(cfg, `apiVersion: v1\nkind: Namespace\nmetadata: { name: ${ns} }\n`);
  await kubectlApply(cfg, rbac(cfg));
  // Recreate per run so each run's file starts empty and the pod carries the run id.
  await kubectl(cfg, ['-n', ns, 'delete', 'deploy', NAME, '--ignore-not-found', '--wait']);
  await kubectlApply(cfg, stringify({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: NAME, namespace: ns, labels: { app: NAME } },
    spec: {
      replicas: 1, selector: { matchLabels: { app: NAME } },
      template: {
        metadata: { labels: { app: NAME, run: runId } },
        spec: {
          serviceAccountName: NAME,
          containers: [{
            name: 'sim', image, imagePullPolicy: 'Never', args: ['truth'],
            env: [{ name: 'TRUTH_FILE', value: cfg.truth.file }],
            resources: { requests: { cpu: cfg.truth.cpu, memory: cfg.truth.memory } },
            volumeMounts: [{ name: 'data', mountPath: cfg.truth.file.replace(/\/[^/]+$/, '') }],
          }],
          volumes: [{ name: 'data', emptyDir: {} }],
        },
      },
    },
  }));
  await kubectl(cfg, ['-n', ns, 'rollout', 'status', `deploy/${NAME}`, '--timeout=180s'], { stdio: 'inherit' });
}

async function truthPod(cfg: SimConfig) {
  const pods = await kubectlJson<{ items: any[] }>(cfg, ['-n', cfg.harness.namespace, 'get', 'pods', '-l', `app=${NAME}`]);
  return pods.items.find((p) => !p.metadata.deletionTimestamp)?.metadata.name as string | undefined;
}

export async function truthCollect(cfg: SimConfig, dest: string) {
  const pod = await truthPod(cfg);
  if (!pod) throw new Error('truth collector pod not found');
  await kubectl(cfg, ['-n', cfg.harness.namespace, 'cp', `${pod}:${cfg.truth.file}`, dest]);
}

export async function truthStop(cfg: SimConfig) {
  await kubectl(cfg, ['-n', cfg.harness.namespace, 'delete', 'deploy', NAME, '--ignore-not-found']);
}
