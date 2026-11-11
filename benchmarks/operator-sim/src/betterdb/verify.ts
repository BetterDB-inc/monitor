import type { SimConfig } from '../config.js';
import { valkeyPods } from '../infra/verify.js';
import { BetterdbApi, type Connection } from './api.js';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// Phase 3 acceptance: seed + every pod registered, all polled, no retire churn.
export async function verifyBetterdb(cfg: SimConfig) {
  const api = new BetterdbApi(cfg);
  const pods = await valkeyPods(cfg);
  const podByIp = new Map(pods.map((p) => [p.ip, p.name]));
  const v = cfg.betterdb.verify;
  const checks: [string, boolean, string][] = [];

  const children = (list: Connection[], seedId: string) => list.filter((c) => c.membership?.seedId === seedId && !c.membership.retiredAt);
  const findSeed = (list: Connection[]) => list.find((c) => !c.membership && c.host.startsWith(`valkey-${cfg.cluster.name}.`));

  // Auto-registration syncs every 30 s; allow `registerCycles` of them.
  let list: Connection[] = [];
  let seed: Connection | undefined;
  const deadline = Date.now() + v.registerCycles * v.syncIntervalSec * 1000;
  for (;;) {
    list = (await api.connections()).connections;
    seed = findSeed(list);
    if (seed && children(list, seed.id).length === pods.length) break;
    if (Date.now() > deadline) break;
    await sleep(cfg.betterdb.pollSec);
  }
  checks.push(['seed connection present', !!seed, seed ? `${seed.name} ${seed.host}:${seed.port}` : 'none']);
  const kids = seed ? children(list, seed.id) : [];
  const mapped = kids.filter((c) => podByIp.has(c.host)).length;
  checks.push([`${pods.length} auto-registered node connections`, kids.length === pods.length && mapped === pods.length, `${kids.length} children, ${mapped} map to pods`]);
  checks.push(['all children connected', kids.every((c) => c.isConnected), `${kids.filter((c) => c.isConnected).length}/${kids.length}`]);

  // Fan-out coverage: with auto-registration every node is its own connection, so the
  // healthy reasons are no_targets / not_applicable / covered_elsewhere (types.ts, v0.55.0).
  const cov = await api.coverage().catch((e: Error) => e);
  if (cov instanceof Error) checks.push(['/api/anomaly/coverage', false, cov.message]);
  else {
    const healthy = new Set(cfg.betterdb.verify.healthyCoverageReasons);
    const bad = cov.filter((c) => c.unreachable || c.authFailed || (c.reason !== null && !healthy.has(c.reason)));
    checks.push([`coverage healthy for seed + ${pods.length} nodes`, cov.length === pods.length + 1 && bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 2)) : `${cov.length} entries, reasons ${[...new Set(cov.map((c) => c.reason))].join(',')}`]);
  }

  // Every child must be feeding z-score buffers (detectors only run on registered connections).
  const fed = await Promise.all(kids.map((c) => api.buffers(c.id).then((b) => b.some((x) => x.sampleCount > 0), () => false)));
  checks.push(['all node connections polled (buffer samples > 0)', fed.every(Boolean), `${fed.filter(Boolean).length}/${kids.length}`]);

  // PR #651 regression check: membership must be stable across `churnWatchSec`.
  const ids = new Set(kids.map((c) => c.id));
  let churn = 0;
  const changes: string[] = [];
  console.log(`watching registration churn for ${v.churnWatchSec}s …`);
  for (let t = 0; t < v.churnWatchSec; t += v.syncIntervalSec) {
    await sleep(v.syncIntervalSec);
    const now = (await api.connections()).connections;
    const cur = new Set(seed ? children(now, seed.id).map((c) => c.id) : []);
    const added = [...cur].filter((x) => !ids.has(x));
    const gone = [...ids].filter((x) => !cur.has(x));
    if (added.length || gone.length) churn++, changes.push(`+${added.length}/-${gone.length}@${t + v.syncIntervalSec}s`);
  }
  checks.push([`no retire/register churn over ${v.churnWatchSec}s`, churn === 0, churn ? changes.join(' ') : 'stable']);

  console.log('\ncheck                                      | ok | detail');
  for (const [name, ok, detail] of checks) console.log(`${name.padEnd(42)} | ${ok ? '✔ ' : '✘ '} | ${detail}`);
  return checks.every(([, ok]) => ok);
}
