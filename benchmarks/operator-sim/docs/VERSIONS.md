# VERSIONS — verified 2026-11-10

All facts read from upstream (gh api / raw / helm show / Docker Hub). No cluster touched.

## Update 2026-11-10 (later same day)

- BetterDB **v0.55.0** released (GitHub release 2026-11-10T15:42Z; image `betterdb/monitor:0.55.0-no-ai` published). Contains #651 (headless/multi-address seed), #654 (`nodeAddr` on per-node events), #673 (`/api/anomaly/coverage`), #682. Deviations 6–8 below are resolved by this release. Chart is still 0.51.1.

## Deviations from assumptions

1. Operator: released CRD uses `spec.replicas` (per shard). `spec.replicasPerShard` (PR #590) is open and not merged.
2. Operator: placement goes under `spec.scheduling.{node,zone}.spread.*` and passthrough affinity, nodeSelector, tolerations and TSCs. All spread modes default to Disabled. There is no single "placement policy" field.
3. Operator: `spec.config` cannot override operator-owned keys: `cluster-allow-replica-migration no`, `cluster-replica-validity-factor 0`, `shutdown-on-sigterm failover`. `cluster-node-timeout` defaults to 15 s. Changing any key outside maxmemory/maxmemory-policy/maxclients rolls every pod.
4. Operator: the default image is `valkey/valkey:9.0.0`, so set `spec.image: valkey/valkey:9.1.3` explicitly. There is no image allowlist.
5. BetterDB chart: the latest published chart is 0.51.1 (appVersion 0.51.1), while the latest app release is v0.54.0. Override `image.tag: 0.54.0-no-ai`.
6. BetterDB PR #651 (multi-address / headless-Service seed fix) is OPEN. It is not in v0.54.0 or on master. Do not seed via the operator's headless Service: use a single pod IP or one node's address.
7. BetterDB: `GET /api/anomaly/coverage` does not exist in v0.54.0 (it is master-only, #673).
8. BetterDB: per-node events carry no `nodeAddr` in v0.54.0. It was added in #654, which is in the local HEAD but unreleased. Attribute events through the `connectionId` of each auto-registered child.
9. BetterDB: no env var enables early access. A keyless instance gets beta/Pro features from the entitlement server, so it needs egress to betterdb.com; otherwise use `BETTERDB_LICENSE_KEY` or an offline license file. Webhooks `anomaly.detected`, `cluster.failover` and `latency.spike` are Pro.
10. BetterDB: auto-registered children are kept in memory only unless `ENCRYPTION_KEY` (≥16 chars) is set.
11. Chaos Mesh 2.8.x officially supports only K8s 1.35, 1.36 and 1.37. "≥1.31" is not enough.
12. The local kind is v0.24.0 (default node image about 1.31). Latest is v0.33.0, which defaults to kindest/node:v1.37.0.
13. NetworkChaos bandwidth: `rate`, `limit` and `buffer` are all required. NetworkChaos also has more actions than assumed (netem, duplicate, corrupt).
14. memtier: `--read-preference` exists (cluster mode only). `--replica-clients` and `--replicas-per-shard` are parsed but do nothing.
15. valkey-benchmark `--rps` is a global total, not per client. In `--cluster`, any non-MOVED/ASK/CLUSTERDOWN error reply makes it `exit(1)`, which matters during chaos. Custom commands need `{tag}` in every key.

## Blockers / risks for 12 shards x 2 replicas on kind

- **Hard blocker: K8s version.** Chaos Mesh 2.8.8 is supported only on K8s 1.35–1.37. Upgrade kind to v0.33.0 or pin `kindest/node:v1.37.0@sha256:a1ed56cf…`. The local kind v0.24.0 would give about 1.31.
- **Hard blocker for cluster-wide BetterDB data: no seed fix.** Without #651, a headless-Service seed churns auto-registration, silently drops slowlog/commandlog entries, shows slot stats for one shard only, and misses atomic slot migrations. Workaround: seed with one pod IP and set CLUSTER_AUTO_REGISTER_NODES=true plus ENCRYPTION_KEY. The seed IP changes if that pod is recreated. Alternatively, build the image from PR #651's branch (`fix/cluster-seed-dns-monitoring`).
- **Data-loss risk (operator #533, a known issue in the release):** without persistence, a chaos action that restarts the server container in place can empty a shard. This covers Chaos Mesh `container-kill`, an OOM kill, and `DEBUG SEGFAULT`/`kill` inside the pod. Prefer `pod-kill`, which gets a fresh emptyDir and joins as a new node, or enable `persistence`. Issue #552: back-to-back node drains without persistence can also lose a shard. #563's fix is not released, so a roll can move on before the replica has synced.
- Name length: the 12×2 layout gives a max shard index of 11 (two digits), so the ValkeyCluster `metadata.name` must be ≤ 40 chars with StatefulSet.
- `cluster-allow-replica-migration no` is forced. Orphaned-primary replica migration will not happen, so do not plan scenarios around it.
- Capacity: 36 Valkey pods plus 36 exporter sidecars plus load generators fit under maxPods 110 on one kind node. RAM is the constraint: about 12 GB was free when checked, out of 62 GB. Set `resources` and `maxmemory`.
- Licensing: anomaly APIs return a Pro-required error if the entitlement call fails (for example, no egress from kind).

---

## 1. valkey-operator (valkey-io/valkey-operator)

| Item | Verified fact | Version / ref | Source | Verdict |
|---|---|---|---|---|
| Latest release | v0.8.0, published 2026-10-22 (prev v0.7.1 2026-09-28) | v0.8.0 | https://github.com/valkey-io/valkey-operator/releases/tag/v0.8.0 | — |
| Helm chart | `valkey/valkey-operator` chart 0.8.0, appVersion v0.8.0; operator image ghcr.io/valkey-io/valkey-operator; chart `kubeVersion: '>=1.20.0-0'`; operator pod limits 500m/128Mi | chart 0.8.0 | `helm show chart valkey/valkey-operator` (repo https://valkey.io/valkey-helm/) | RIGHT |
| CRD apiVersion | `valkey.io/v1alpha1`, kind `ValkeyCluster` | v0.8.0 | config/crd/bases/valkey.io_valkeyclusters.yaml | RIGHT |
| Replica field | Released CRD uses **`spec.replicas`** (int32, min 0, = replicas *per shard*). `spec.replicasPerShard` is PR #590, **open, unmerged** | v0.8.0 | api/v1alpha1/valkeycluster_types.go L329; https://github.com/valkey-io/valkey-operator/pull/590 | use `replicas` |
| Shards | `spec.shards` int32, required, min 1 | v0.8.0 | types.go L325 | RIGHT |
| Image | `spec.image` (string). Default `valkey/valkey:9.0.0`. No allowlist/pinning; operator parses the tag only for version-gated config (e.g. `tls-auto-reload-interval` ≥ 9.1.0); `latest`/digest → gated keys dropped + ConfigurationWarning | v0.8.0 | internal/controller/valkeycluster_controller.go L48; docs/valkeycluster.md#version-gated-config | no allowlist |
| Resources | `spec.resources` (corev1.ResourceRequirements) for server container | v0.8.0 | types.go L333 | RIGHT |
| Exporter | `spec.exporter.{enabled (default true), image, resources, securityContext, args}`; sidecar `metrics-exporter`, port **9121**; default image `oliver006/redis_exporter:v1.88.0` (Docker Hub latest v1.97.0). v0.8.0 fixed `_exporter` ACL so `redis_commandlog_*` metrics export | v0.8.0 | types.go L624-645; docs/valkeycluster.md#metrics | RIGHT |
| Persistence | `spec.persistence.{size, storageClassName, reclaimPolicy: Retain|Delete}`; StatefulSet only; immutable add/remove; size grow-only. Unset → `/data` is emptyDir | v0.8.0 | docs/valkeycluster.md#persistence | RIGHT |
| workloadType | `StatefulSet` (default) \| `Deployment`; immutable | v0.8.0 | types.go L350 | RIGHT |
| Config passthrough | `spec.config` map[string]string. Live (no roll): `maxclients`, `maxmemory`, `maxmemory-policy`. Everything else (slowlog-log-slower-than, commandlog-*, enable-debug-command, cluster-node-timeout) rolls pods. Operator-owned keys are overwritten: dir, cluster-config-file, aclfile, cluster-enabled=yes, protected-mode=no, **cluster-allow-replica-migration=no**, **cluster-replica-validity-factor=0**, **shutdown-on-sigterm=failover**, TLS keys. `cluster-node-timeout` unset → Valkey default 15000 ms | v0.8.0 | internal/controller/config.go L90-180; docs/valkeycluster.md#config | PARTIAL (passthrough works; note owned keys) |
| Placement | `spec.scheduling.{affinity, nodeSelector, tolerations, topologySpreadConstraints, priorityClassName, node.spread.{shard,primaries,pods}.mode, zone.spread.*, zone.pinning.zones}`; modes Disabled\|Preferred\|Required; all default Disabled | v0.8.0 | types.go L100-270; docs/valkeycluster.md#scheduling | PARTIAL (it is `scheduling`, not a flat affinity/policy field) |
| Other v0.8.0 fields | `serviceAccountName`, `podMetadata.{labels,annotations}`, `users`, `containers`, `networking.{discovery,tls}`, `podDisruptionBudget.mode`, `podSecurityContext`, `terminationGracePeriodSeconds` | v0.8.0 | types.go | — |
| main-only (unreleased) | `spec.users`→`spec.acl.users` (#558), default user disabled unless declared (#620), opt-in ClusterIP Service per node (#490), clientAuth.ca (#573) | main @71047445 | commits since v0.8.0 | do not use with v0.8.0 |
| Min K8s | docs: Kubernetes **v1.31+**, kubectl v1.31+ (chart metadata says >=1.20, ignore) | v0.8.0 | docs/quickstart.md L7 | RIGHT |
| ValkeyNode | Internal CRD `valkey.io/v1alpha1 ValkeyNode`, one per shard×node, owns a single-replica StatefulSet/Deployment + pod. "do not create or modify directly". Must apply both CRDs on upgrade | v0.8.0 | docs/valkeycluster.md#architecture; release notes | RIGHT |
| Name length | StatefulSet name `valkey-<name>-<shard>-<node>` ≤ 52 chars. Name ≤ 41 with single-digit indexes, −1 per extra digit. **12 shards (index 11) × 2 replicas (index 2) → name ≤ 40.** Deployment: ≤ 56. Enforced at admission (#496) | v0.8.0 | docs/valkeycluster.md#workload-type | RIGHT |
| Headless Service | Cluster exposed via headless Service `valkey-<name>` (resolves to all pods) | v0.8.0 | docs; BetterDB PR #651 | — |
| Known issue (release) | #533: without persistence, a primary whose `valkey-server` crashes and restarts in place within cluster-node-timeout rejoins as same node ID, empty; replicas full-sync to empty → **shard data loss**, cluster reports Ready. Fix PR #537 open | v0.8.0 | https://github.com/valkey-io/valkey-operator/issues/533 | — |
| #552 | OPEN. No persistence: draining replica node then primary node loses a shard (readiness = PING only; PDB lets primary go before new replica synced; empty replica promoted via TAKEOVER) | — | https://github.com/valkey-io/valkey-operator/issues/552 | — |
| #563 | CLOSED 2026-10-30 (after v0.8.0) but linked fix PR #562 still **open/unmerged** → behaviour is in v0.8.0: during a roll, next node in shard rolls before replica finishes streaming (`master_sync_in_progress:1`) | — | https://github.com/valkey-io/valkey-operator/issues/563 | — |
| #591 | OPEN. SIGTERM failover cannot win election on 1- and 2-shard clusters (needs ≥3 primaries). Not applicable to 12 shards | — | https://github.com/valkey-io/valkey-operator/issues/591 | — |

## 2. Docker Hub valkey/valkey

| Item | Verified fact | Source | Verdict |
|---|---|---|---|
| 9.1.2 | exists (pushed 2026-09-21) | https://hub.docker.com/v2/repositories/valkey/valkey/tags/9.1.2 | RIGHT |
| 9.1.3 | exists (pushed 2026-10-27); GitHub release 2026-10-26; latest stable | same /tags/9.1.3; github.com/valkey-io/valkey/releases | RIGHT |
| 9.1.4 | does not exist (404) | — | — |
| Latest 9.x | 9.1.3, 9.1.2, 9.1.1, 9.1.0; 9.0.7 (2026-10-27) … 9.0.0; floating `9.1`, `9.0`; pre-release `9.2.0-rc2` (2026-11-04), `9.2-rc`. A floating `9.2` tag exists (dated 2026-09-21) — do not use | Docker Hub tags API | — |
| Operator default | `valkey/valkey:9.0.0` unless `spec.image` set | valkeycluster_controller.go | — |

## 3. BetterDB Monitor (BetterDB-inc/monitor)

Latest release **v0.54.0** (2026-11-03, tag commit 675967a3). Local checkout HEAD 6988a790 (`bench/split-brain`) is 13 commits past v0.54.0 and is an ancestor of upstream/master (28 commits past v0.54.0).

| Item | Verified fact | Version / ref | Source | Verdict |
|---|---|---|---|---|
| Helm repo / chart | `helm repo add betterdb https://docs.betterdb.com/charts`; chart `betterdb/betterdb-monitor` **0.51.1, appVersion 0.51.1** (latest published; also in repo at HEAD). Default image tag `<appVersion>-no-ai` → `betterdb/monitor:0.51.1-no-ai` | chart 0.51.1 | `helm search repo betterdb`; charts/betterdb-monitor/Chart.yaml | WRONG if assumed chart = 0.54 → set `image.tag: 0.54.0-no-ai` |
| Images | `betterdb/monitor:0.54.0` (AI), `0.54.0-no-ai` (standard), `latest` all 2026-11-03 | 0.54.0 | Docker Hub betterdb/monitor | — |
| Values: db | `db.host`, `db.port` (6379), `db.username` (default), `db.type` auto, `db.tls`, `db.password` or `db.existingSecret`/`db.existingSecretKey` (db-password) → env DB_HOST/DB_PORT/DB_USERNAME/DB_TYPE/DB_TLS/DB_PASSWORD | 0.51.1 | charts/betterdb-monitor/values.yaml L24-39 | RIGHT |
| Values: storage | `storage.type` (memory default \| postgres), `storage.url` or `existingSecret`/`existingSecretKey` → STORAGE_TYPE/STORAGE_URL. Env enum: sqlite, postgres, postgresql, turso, memory (sqlite not in image). STORAGE_URL required for postgres | v0.54.0 | env.schema.ts L104, L380 | RIGHT |
| Other values | `license.key`/`existingSecret`, `license.offline`, `telemetry`, `extraEnv`, `extraEnvFrom`, `service.port` 3001 | 0.51.1 | values.yaml | — |
| CLUSTER_AUTO_REGISTER_NODES | env, string, default `false`; per-connection override. Sync every 30 s, 30 s budget, 4 new nodes in parallel. Children named `<seed> · host:port`, dial announced addr from CLUSTER NODES. **Without `ENCRYPTION_KEY` (≥16 chars) children are in-memory only** | v0.54.0 | env.schema.ts L340; docs/cluster-auto-registration.md; connection-registry.service.ts L1461 | RIGHT (+ set ENCRYPTION_KEY) |
| PATCH /api/connections/:id/auto-register | exists; body `{ "enabled": true|false|null }` (null = follow env); seed connections only (400 otherwise) | v0.54.0 | apps/api/src/connections/connections.controller.ts L236 | RIGHT |
| Multi-address seed fix | PR #651 ("monitor clusters whose seed host fronts several nodes (Kubernetes operator)") is **OPEN, not merged** → **not in v0.54.0 nor master**. With headless-Service seed: auto-register churn, slowlog/commandlog entries silently dropped, slot stats one shard, Valkey 9 atomic slot migration invisible | — | https://github.com/BetterDB-inc/monitor/pull/651 | WRONG |
| ANOMALY_POLL_INTERVAL_MS | int, min 100, default 1000 | v0.54.0 | env.schema.ts L191 | RIGHT |
| ANOMALY_DETECTION_ENABLED | default true | v0.54.0 | env.schema.ts L187 | — |
| API prefix | `/api` only in production build with bundled UI (Docker image) — dev server has no prefix | v0.54.0 | apps/api/src/main.ts L151 | — |
| GET /api/connections | exists | v0.54.0 | connections.controller.ts L55 | RIGHT |
| GET /api/anomaly/events | query `limit` (100), `metricType`, `startTime`, `endTime` (epoch **ms**, ints, start ≤ end), `activeOnly`; default window last 24 h; header **`x-connection-id`** (optional). Guarded: LicenseGuard + Feature.ANOMALY_DETECTION | v0.54.0 | proprietary/anomaly-detection/anomaly.controller.ts L56 | RIGHT |
| GET /api/anomaly/groups | `limit` (50), `pattern`, `startTime`, `endTime`; same header/guard | v0.54.0 | anomaly.controller.ts L93 | RIGHT |
| GET /api/anomaly/coverage | **not in v0.54.0** (nor local HEAD); exists only on upstream/master (#673, unreleased) | master | anomaly.controller.ts L145 @ upstream/master | WRONG |
| Other anomaly routes (v0.54.0) | summary, buffers, replication-divergence, incidents, incidents/:id, POST events/:id/resolve, groups/:id/resolve, events/clear-resolved | v0.54.0 | anomaly.controller.ts | — |
| nodeAddr on events | **not in v0.54.0** (`AnomalyEvent` has `connectionId`, `replicaAddr`, `scopeId` only). `nodeAddr` added by #654 (in local HEAD, unreleased); stored-event filter by node address #682 (master only) | v0.54.0 | proprietary/anomaly-detection/types.ts | WRONG for released image → attribute per node via `connectionId` of auto-registered child |
| Prometheus | `GET /api/prometheus/metrics`, prefix `betterdb_`; summary gauges every ANOMALY_PROMETHEUS_INTERVAL_MS (30000) | v0.54.0 | apps/api/src/prometheus/prometheus.controller.ts; README L348 | RIGHT |
| OpenAPI | Swagger UI at **`/docs`** (not under /api); JSON at `/docs-json` (Nest default) | v0.54.0 | main.ts L198; README L133 | — |
| Webhook events | `anomaly.detected`, `cluster.failover`, `latency.spike` exist; all three **Tier.pro** | v0.54.0 | packages/shared/src/webhooks/types.ts L8-19, L111+ | RIGHT |
| Licensing | Anomaly detection = Feature.ANOMALY_DETECTION in **Pro** tier ("free in early access"). No special env var for early access: keyless instance calls the entitlement server at startup to get beta features (needs egress to betterdb.com). Otherwise `BETTERDB_LICENSE_KEY` or offline `BETTERDB_OFFLINE_LICENSE_FILE`. Community → API returns "This feature requires a pro license" | v0.54.0 | proprietary/licenses/license.service.ts L209-215; license.guard.ts; packages/shared/src/license/types.ts L58-82; README L107 | PARTIAL |
| Z-score defaults | warning z 2.0, critical z 3.0, **consecutiveRequired 3**, **cooldown 60 000 ms**. Overrides: memory_used 2.5/3.5; slowlog_last_id 1.5/2.5, consec 1, cooldown 30 s; acl_denied 1.5/2.5, abs 10/50, consec 2, 30 s; evicted_keys consec 2, 30 s; fragmentation_ratio abs 1.5/2.0, consec 5, 120 s; error_replies z 3/5, abs 200/2000, consec 2; connection_churn z 3/5, consec 2, 60 s; rejected_connections/evicted_clients 1.5/2.5, consec 1, 30 s | v0.54.0 | apps/api/src/anomaly/anomaly.types.ts L97-155; spike-detector.ts L40-47; anomaly.service.ts L1303, L1893 | — |
| Warmup / window | MetricBuffer `minSamples = 30` (warmup), `maxSamples = 300` (rolling window) → 30 s / 5 min at 1 s poll | v0.54.0 | proprietary/anomaly-detection/metric-buffer.ts L10-11 | — |
| Window detectors | replication divergence: 30 s windows (or 3 polls), min 3 samples; retry amplification: 60 s windows, 10-window warmup, 3-window run; load saturation consec 3; correlation window 5 s | v0.54.0 | docs/anomaly-detection.md; *-detector.ts | — |
| Registered-only | YES: MultiConnectionPoller iterates `connectionRegistry.list()` (connected, non-sentinel by default); each connection evaluated alone — a cluster seed only sees the node it points at. Need CLUSTER_AUTO_REGISTER_NODES for per-node coverage | v0.54.0 | apps/api/src/common/services/multi-connection-poller.ts L205-230; docs/anomaly-detection.md L363 | RIGHT |

## 4. Load generators

|---|---|---|---|---|
| memtier latest | 2.5.2 (2026-10-07); not installed locally | 2.5.2 | https://github.com/RedisLabs/memtier_benchmark/releases ; memtier_benchmark.cpp@2.5.2 | — |
| --cluster-mode | exists ("Run client in cluster mode") | 2.5.2 | memtier_benchmark.cpp | RIGHT |
| --ratio | `Set:Get`, default 1:10 | 2.5.2 | same | RIGHT |
| --key-pattern | `X:Y`, X,Y ∈ {S,R,G,P,Z}; default R:R; G=Gaussian (`--key-stddev`, default range/6; `--key-median`), Z=zipf (`--key-zipf-exp`, 0<e<5, default 1); P only as P:P; key-min 0, key-max 10000000, prefix `memtier-` | 2.5.2 | same | RIGHT |
| --rate-limiting | **per connection** req/s; total = rate × -c (default 50) × -t (default 4) | 2.5.2 | same | RIGHT |
| --test-time | seconds | 2.5.2 | same | RIGHT |
| --json-out-file | exists | 2.5.2 | same | RIGHT |
| --read-preference | exists: primary (default) \| secondary \| secondaryPreferred \| nearest; `--read-preference-fallback=error\|queue\|primary` (queue = error); `--command-is-read`; cluster-mode only; incompatible with --transaction. `--replica-clients`, `--replicas-per-shard` parsed but not wired | 2.5.2 | same | PARTIAL |
| valkey-benchmark | latest 9.1.3 (local binary 9.1.0). `--cluster`: built-in tests use `key:{tag}:__rand_int__`; `{tag}` replaced per request with a hash tag for a slot owned by the client's node. Custom command keys **must contain `{tag}`**. `-t` ignored with custom command. `-c` ≥ node count; `--threads` defaults to node count. MOVED/ASK/CLUSTERDOWN recovered only for `{tag}` keys; other error replies → exit(1). `--rps` = **global** token bucket. `--rfr no\|yes\|all` replica reads. `--duration`, `--warmup` | 9.1.3 | https://raw.githubusercontent.com/valkey-io/valkey/9.1.3/src/valkey-benchmark.c | RIGHT (+ caveats) |
| @valkey/valkey-glide | latest stable **2.5.3** (npm 2026-09-24); `next` = 2.6.0-rc5 (2026-11-10) | 2.5.3 | https://registry.npmjs.org/@valkey/valkey-glide | — |
| GlideClusterClient | `GlideClusterClient.createClient({ addresses: [{host, port?}], readFrom?, clientAz?, ... })` → Promise; readFrom: `primary`, `preferReplica`, `AZAffinity`, `AZAffinityReplicasAndPrimary`, `allNodes` | 2.5.3 | build-ts/BaseClient.d.ts | RIGHT |
| Node 22 | engines `node >=16`; CI matrix 20/22/24/26; native pkgs linux x64/arm64 gnu+musl, darwin x64/arm64 (glibc ≥2.17, musl ≥1.2.3) | 2.5.3 | valkey-glide .github/json_matrices/supported-languages-versions.json | RIGHT |

## 5. Chaos Mesh / kind

|---|---|---|---|---|
| Chaos Mesh latest | v2.8.8 (2026-11-06); helm chart `chaos-mesh/chaos-mesh` 2.8.8 / appVersion 2.8.8 (repo https://charts.chaos-mesh.org) | 2.8.8 | https://github.com/chaos-mesh/chaos-mesh/releases/tag/v2.8.8 | — |
| Helm for kind | `--set chaosDaemon.runtime=containerd --set chaosDaemon.socketPath=/run/containerd/containerd.sock` (defaults docker / /var/run/docker.sock; chart comment gives exactly these for kind) | 2.8.8 | `helm show values chaos-mesh/chaos-mesh` | RIGHT |
| Supported K8s | 2.8: **1.35, 1.36, 1.37** (e2e on 1.35, 1.37); 2.7: 1.35–1.37 per table row; 2.6: 1.26–1.28. 1.31–1.34 not listed | 2.8 | https://chaos-mesh.org/supported-releases/ | WRONG (≥1.31 insufficient) |
| PodChaos | `action` pod-kill \| pod-failure \| container-kill; `mode` one \| all \| fixed \| fixed-percent \| random-max-percent; `value` string; `selector.{namespaces, labelSelectors, pods, …}`; `duration` (required for pod-failure); `gracePeriod` int64 (pod-kill, default 0); `containerNames` (required for container-kill) | v2.8.8 | api/v1alpha1/podchaos_types.go, podchaos_webhook.go | RIGHT |
| NetworkChaos | `action` netem \| delay \| loss \| duplicate \| corrupt \| partition \| bandwidth; `delay.{latency (req), jitter, correlation, reorder}`; `bandwidth.{rate, limit (≥1), buffer (≥1)}` **all required**, `peakrate`, `minburst` optional; `direction` to (default) \| from \| both; `target` PodSelector (selector+mode+value); `externalTargets` []string; `duration`; `device`, `targetDevice` | v2.8.8 | api/v1alpha1/networkchaos_types.go | PARTIAL (limit/buffer required) |
| kind latest | **v0.33.0** (2026-08-26); default `kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5`; also v1.36.4, v1.35.8, v1.34.11 | v0.33.0 | https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0 ; pkg/apis/config/defaults/image.go | RIGHT (≥1.31) |
| Local kind | v0.24.0 at ~/.local/bin/kind (default image ~1.31) → upgrade or pin image | — | local | — |
| kind limits | inotify: needs max_user_watches 524288 / max_user_instances 512 (host has 524288 / 1024 — OK); kubelet maxPods 110 default | v0.33.0 | site/content/docs/user/known-issues.md | — |
