# Publish the Helm chart with every app release, and add common Service options

**Suggested labels:** `helm`, `ci`, `release`, `kubernetes`, `enhancement`  ·  **Area:** `charts/betterdb-monitor`, `.github/workflows`  ·  **Severity:** medium (`helm install` gives users a monitor four releases old by default, without the Kubernetes headless-seed fix and the longer startup probe that the docs say the chart has)

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

The published chart `betterdb/betterdb-monitor` is still **0.51.1** (appVersion 0.51.1). The app has since shipped 0.52.0, 0.53.0, 0.54.0 and 0.55.0. The chart takes its default image tag from `appVersion`, so a plain `helm install` or `helm upgrade` deploys monitor 0.51.1. That version lacks the fix for seeding a cluster through a Kubernetes headless Service (PR #651, released in 0.55.0), and lacks the 10-minute startup probe that `docs/updating.md` says "the chart allows". The cause is a gap in the release process. App releases bump the three `package.json` files but not `Chart.yaml`. The chart publish workflow runs only when files under `charts/` change, and its version-sync check runs after merge, where it fails without anyone noticing: it last failed on 2026-11-10 and nothing was published. Separately, `templates/service.yaml` renders only `type` and `port`, so `nodePort`, annotations, `loadBalancerSourceRanges` and `externalTrafficPolicy` cannot be set, and they are silently ignored if you try.

## How we found it

The `benchmarks/operator-sim` harness in this repo installs BetterDB with the official chart into a kind cluster next to a Valkey cluster managed by the Kubernetes operator. It pins chart versions in `benchmarks/operator-sim/config/sim.yaml` (`charts.betterdbMonitor`).

- kind v0.33.0, Kubernetes v1.37.0. `helm upgrade --install betterdb betterdb-monitor --repo https://docs.betterdb.com/charts --version 0.51.1` (`benchmarks/operator-sim/src/infra/betterdb.ts:84-89`).
- To run the current app (v0.55.0), the harness has to override `image.tag=0.55.0-no-ai` (`config/sim.yaml`, `betterdb.imageTag`). See `benchmarks/operator-sim/docs/VERSIONS.md`.
- To reach the UI through kind's host-port mapping, the harness needs a fixed `nodePort`. The chart cannot set one, so the harness creates a second, hand-written `NodePort` Service next to the chart's (`benchmarks/operator-sim/src/infra/betterdb.ts:91-96`).

## Observed behaviour

**Chart and app versions** (checked 2026-11-11):

| Source | Value |
|---|---|
| `helm show chart betterdb-monitor --repo https://docs.betterdb.com/charts` | `version: 0.51.1`, `appVersion: 0.51.1` |
| `docs/charts/index.yaml` on master | newest entry 0.51.1, created 2026-10-21 |
| `charts/betterdb-monitor/Chart.yaml` on master | `version: 0.51.1`, `appVersion: "0.51.1"` |
| `apps/api/package.json` on master | `0.55.0` |
| App tags | v0.51.1 (10-21), v0.52.0 (10-28), v0.53.0 (10-30), v0.54.0 (11-03), v0.55.0 (11-10) |

**Release commits:** the v0.51.1 "version bump" (`13cbd020`) changed `Chart.yaml` along with the three `package.json` files. The later "version bump" commits for 0.52.0, 0.53.0, 0.54.0 and 0.55.0 (`3922bc34`, `22872ade`, `675967a3`, `ee9d1735`) change `package.json` files only (root, `apps/api`, `apps/web`, plus two packages in `22872ade`), never `Chart.yaml`.

**Publish workflow runs** (`gh run list --workflow helm-publish.yml`):

| Date | Commit | Result |
|---|---|---|
| 2026-10-21 | `13cbd020` version bump | failure (twice) |
| 2026-10-21 | `db35159a` chore(chart): point artifacthub image tags at 0.51.1 | success → 0.51.1 published |
| 2026-11-10 | `7d60dd14` fix: monitor clusters whose seed host fronts several nodes (#651) | **failure**: `Chart.yaml appVersion (0.51.1) != apps/api/package.json (0.54.0)` |

So #651's chart change (`startupProbe.failureThreshold` 30 → 120 in `values.yaml`) is on master but has never been published.

**Effect on users:**
- `helm install` with no overrides runs `betterdb/monitor:0.51.1-no-ai`.
- `docs/updating.md:105-107` says that "each chart release pins the image to the version it was published for, so updating is just pulling the newer chart". There has been no newer chart for four releases.
- `docs/updating.md:183` says that "the chart allows 10 minutes" for the slow-log index rebuild. The published chart allows 150 s (`30 × 5 s`).

**Service options:** rendering the master chart with `--set service.type=NodePort --set service.nodePort=30301 --set-string service.annotations.foo=bar` produces a Service with no `nodePort` and no annotations. Both values are accepted (`values.schema.json` does not restrict `service` properties) and ignored without a warning.

## Expected behaviour

- Every app release `vX.Y.Z` is followed, without manual steps, by a published chart whose `appVersion` is `X.Y.Z`, and whose default image `X.Y.Z-no-ai` already exists on Docker Hub when the chart becomes visible.
- A pull request that would leave the chart out of sync with the app fails CI **before** it merges. Drift is not reported only by a post-merge job that nobody watches.
- The chart's Service supports the options most Kubernetes users need: `nodePort`, annotations (cloud load-balancer settings, ExternalDNS), `loadBalancerSourceRanges`, `loadBalancerClass` and `externalTrafficPolicy`.
- Unknown keys under `service` are rejected by the values schema rather than ignored.

## Root cause

1. **The chart is only published when files under `charts/` change.** `.github/workflows/helm-publish.yml:21-27`:
   ```yaml
   on:
     push:
       branches: [master]
       paths:
         - "charts/betterdb-monitor/**"
         - ".github/workflows/helm-publish.yml"
   ```
   App releases are driven by tags (`.github/workflows/docker-publish.yml:3-6`, `tags: ['v*']`), and neither that workflow nor anything else touches the chart.

2. **`Chart.yaml` is hand-maintained and the release bump skips it.** `charts/betterdb-monitor/Chart.yaml:5-10` (`version`, `appVersion`) and `:35-39` (the `artifacthub.io/images` tags) must be edited by hand. `charts/betterdb-monitor/README.md` ("Releasing the chart (maintainers)") documents this, but the "version bump" commits for 0.52–0.55 did not do it.

3. **The drift check exists, but only post-merge.** `helm-publish.yml:50-68` compares `appVersion` with `apps/api/package.json` and fails on a mismatch, which is good. But it runs only on master pushes that touch `charts/` (see 1), so a release bump never triggers it, and when it does fail, master is already merged. Nothing runs `helm lint` or the version check on pull requests (`.github/workflows/api-tests.yml` paths do not include `charts/**`).

4. **No ordering guarantee between chart and image.** In the 0.51.1 flow the chart was published from a master push (`db35159a`), independently of the tag build that pushes `betterdb/monitor:0.51.1-no-ai`. Nothing checks that the image a chart points at already exists.

5. **The Service template is minimal.** `charts/betterdb-monitor/templates/service.yaml:1-15`:
   ```yaml
   spec:
     type: {{ .Values.service.type }}
     ports:
       - name: http
         port: {{ .Values.service.port }}
         targetPort: http
         protocol: TCP
   ```
   `values.yaml:81-83` has only `type` and `port`. `values.schema.json` lists `type` (enum `ClusterIP`/`NodePort`/`LoadBalancer`) and `port`, without `additionalProperties: false`.

## Proposed change

### A. Release automation

1. **One version-bump script** (`scripts/bump-version.mjs <X.Y.Z>`) that updates `package.json`, `apps/api/package.json`, `apps/web/package.json`, and in `charts/betterdb-monitor/Chart.yaml` the `appVersion`, `version` and both `artifacthub.io/images` tags. Release commits use the script instead of hand edits. The README "Releasing the chart" section points to it.

2. **Chart version policy: lockstep.** Recommended: chart `version` == `appVersion` == app version on every app release, which matches the history (0.40.0, 0.49.0 and 0.51.1 were all published in lockstep). A chart-only fix between releases waits for the next app release, or is shipped as an app patch release. The alternative is an independent chart SemVer, auto-bumped (minor on app release, patch on chart-only change). That works too, but users would then need a mapping table. Maintainers decide (see open questions).

3. **Publish from the tag, after the images exist.** Add a `publish-chart` job to `docker-publish.yml` that `needs: [merge-with-ai, merge-without-ai]`, or a workflow triggered by `workflow_run` of "Build and Push Docker Image" with `conclusion == success`. It:
   - checks that `Chart.yaml` `appVersion` equals the tag (`${GITHUB_REF_NAME#v}`), failing the release with a clear message if not;
   - checks that `docker manifest inspect betterdb/monitor:${v}-no-ai` and `betterdb/monitor:${v}` both succeed;
   - packages, signs and commits the chart using the same steps as `helm-publish.yml:80-156` (factor them into a reusable workflow or composite action so there is one copy).

   Keep `helm-publish.yml` on `workflow_dispatch` for manual re-publishing. Also keep it on push for chart-only changes if the independent-version policy is chosen, and give it the same image-exists check.

4. **Pre-merge CI** (new `.github/workflows/chart-tests.yml`, on `pull_request` for `charts/**`, `package.json`, `apps/api/package.json` and `apps/web/package.json`):
   - the version-sync check from `helm-publish.yml:58-67`, moved into `scripts/check-chart-version.sh` and called from both places;
   - `helm lint charts/betterdb-monitor`;
   - `helm unittest charts/betterdb-monitor` (see C);
   - `helm template` with a small matrix of values files (`ci/default.yaml`, `ci/nodeport.yaml`, `ci/loadbalancer.yaml`), optionally piped through `kubeconform -strict`.

5. **Docs:** `docs/install/kubernetes.md` and `docs/updating.md` stay accurate as long as the automation runs. Add one line saying the chart version equals the app version, so `helm search repo betterdb --versions` shows which monitor release each chart deploys.

6. **Fix the backlog now:** publish a chart for 0.55.0 (or the current release) so the published chart includes #651's `startupProbe` change.

### B. Service template options

`values.yaml`:

```yaml
service:
  type: ClusterIP
  port: 3001
  # Fixed node port (30000-32767) for type NodePort/LoadBalancer; empty = allocated.
  nodePort: null
  annotations: {}
  labels: {}
  # type LoadBalancer only
  loadBalancerClass: ""
  loadBalancerSourceRanges: []
  # type NodePort/LoadBalancer only: Cluster (default) or Local (keeps client source IP)
  externalTrafficPolicy: ""
```

`templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "betterdb-monitor.fullname" . }}
  labels:
    {{- include "betterdb-monitor.labels" . | nindent 4 }}
    {{- with .Values.service.labels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with .Values.service.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  type: {{ .Values.service.type }}
  {{- $external := has .Values.service.type (list "NodePort" "LoadBalancer") }}
  {{- if and $external .Values.service.externalTrafficPolicy }}
  externalTrafficPolicy: {{ .Values.service.externalTrafficPolicy }}
  {{- end }}
  {{- if eq .Values.service.type "LoadBalancer" }}
  {{- with .Values.service.loadBalancerClass }}
  loadBalancerClass: {{ . }}
  {{- end }}
  {{- with .Values.service.loadBalancerSourceRanges }}
  loadBalancerSourceRanges:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- end }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      {{- if and $external .Values.service.nodePort }}
      nodePort: {{ .Values.service.nodePort }}
      {{- end }}
  selector:
    {{- include "betterdb-monitor.selectorLabels" . | nindent 4 }}
```

`values.schema.json` → `service`:
- `nodePort`: integer 30000–32767 or null;
- `annotations` and `labels`: objects of strings;
- `loadBalancerClass`: string;
- `loadBalancerSourceRanges`: array of strings (CIDR pattern);
- `externalTrafficPolicy`: enum `""`, `Cluster`, `Local`;
- `additionalProperties: false`.

Back-compat: all new keys default to "not rendered", so existing installs produce a byte-identical Service. `additionalProperties: false` will reject installs that already set unknown `service.*` keys, which today do nothing. Mention this in the release notes as a deliberate fail-fast. If that is too strict for a minor release, leave it out for one release and log a `NOTES.txt` warning for unknown keys instead.

Update `charts/betterdb-monitor/README.md`'s values table (currently `service.type` / `service.port` only).

### C. Chart tests

Add `charts/betterdb-monitor/tests/service_test.yaml` (helm-unittest):

```yaml
suite: service
templates: [templates/service.yaml]
tests:
  - it: default is ClusterIP without nodePort/annotations
    asserts:
      - equal: { path: spec.type, value: ClusterIP }
      - notExists: { path: spec.ports[0].nodePort }
      - notExists: { path: metadata.annotations }
  - it: renders nodePort for NodePort
    set: { service.type: NodePort, service.nodePort: 30301 }
    asserts:
      - equal: { path: spec.ports[0].nodePort, value: 30301 }
  - it: ignores nodePort for ClusterIP
    set: { service.nodePort: 30301 }
    asserts:
      - notExists: { path: spec.ports[0].nodePort }
  - it: LoadBalancer options
    set:
      service.type: LoadBalancer
      service.loadBalancerSourceRanges: ["203.0.113.0/24"]
      service.externalTrafficPolicy: Local
      service.annotations: { service.beta.kubernetes.io/aws-load-balancer-scheme: internal }
    asserts:
      - equal: { path: spec.loadBalancerSourceRanges[0], value: 203.0.113.0/24 }
      - equal: { path: spec.externalTrafficPolicy, value: Local }
      - equal: { path: "metadata.annotations[\"service.beta.kubernetes.io/aws-load-balancer-scheme\"]", value: internal }
  - it: no LB-only fields on NodePort
    set: { service.type: NodePort, service.loadBalancerSourceRanges: ["203.0.113.0/24"] }
    asserts:
      - notExists: { path: spec.loadBalancerSourceRanges }
```

Plus `tests/deployment_test.yaml`: with `image.tag` empty, the container image is `betterdb/monitor:<Chart.AppVersion>-no-ai` (catches a broken default after a bump).

## Acceptance criteria

- [ ] A published chart exists whose `appVersion` equals the latest app release, and `helm show chart betterdb-monitor --repo https://docs.betterdb.com/charts` reports it.
- [ ] Pushing tag `vX.Y.Z` publishes chart `X.Y.Z` with `appVersion X.Y.Z` after both Docker images are pushed, with no manual chart edit beyond running the bump script.
- [ ] Pushing a tag whose version differs from `Chart.yaml` `appVersion` fails the release job with a message naming both versions.
- [ ] A PR that changes `apps/api/package.json` version without updating `Chart.yaml` fails `chart-tests.yml`.
- [ ] `helm lint` and `helm unittest` run on every PR that touches `charts/**`.
- [ ] `helm template --set service.type=NodePort --set service.nodePort=30301` renders `nodePort: 30301`. With the default values the rendered Service is identical to the current one.
- [ ] `service.annotations`, `service.labels`, `loadBalancerSourceRanges`, `loadBalancerClass` and `externalTrafficPolicy` render only for the Service types where Kubernetes accepts them.
- [ ] `--set service.nodeport=30301` (a typo) is rejected by the values schema.
- [ ] The chart README values table lists every `service.*` key.

## Test plan

- **Unit (helm-unittest):** `helm plugin install https://github.com/helm-unittest/helm-unittest && helm unittest charts/betterdb-monitor`. Covers the cases in C.
- **Render matrix:** `for f in charts/betterdb-monitor/ci/*.yaml; do helm template t charts/betterdb-monitor -f "$f" | kubeconform -strict -summary; done`.
- **Version check:** run `scripts/check-chart-version.sh` with `apps/api/package.json` at `0.56.0` and `Chart.yaml` at `0.55.0` → exit 1 naming both. Equal versions → exit 0.
- **Release dry run:** on a fork, push tag `v0.0.0-test` with matching `Chart.yaml`. The `publish-chart` job waits for the image jobs, the manifest check passes, and the chart is committed. With a mismatched `Chart.yaml` the job fails before packaging.
- **Harness check** (`benchmarks/operator-sim`): once a current chart is published, set `charts.betterdbMonitor.version` in `config/sim.yaml` to the new chart version and clear `betterdb.imageTag`/`buildRef`. Set `service: { type: NodePort, nodePort: 30301 }` in `infra/betterdb/values.yaml` and remove the hand-written NodePort Service from `src/infra/betterdb.ts:91-96`. Then:
  ```sh
  cd benchmarks/operator-sim
  make up betterdb
  ```
  Look for: `kubectl -n betterdb get svc` shows one Service of type NodePort on 30301, `curl localhost:3001/api/health` is OK, and the running image is `betterdb/monitor:<latest>-no-ai` without a tag override.

## Out of scope / open questions

- **Lockstep or independent chart versions?** Lockstep is recommended above. Maintainers decide.
- Whether the chart should also expose `ipFamilyPolicy`/`ipFamilies`, `sessionAffinity`, or a separate metrics Service. Not needed by anything we ran.
- Moving the Helm repo from `docs/charts` on master to an OCI registry (`oci://`) would remove the need for the signed-commit PAT. That is a separate decision.
- Artifact Hub will show the new versions once `index.yaml` is updated; nothing else is needed there.

## References

- `.github/workflows/helm-publish.yml:21-27` (trigger), `:50-68` (preflight), `:80-156` (package, sign, commit)
- `.github/workflows/docker-publish.yml:3-33` (tag trigger and version)
- `charts/betterdb-monitor/Chart.yaml:5-10`, `:35-39`
- `charts/betterdb-monitor/templates/service.yaml:1-15`, `charts/betterdb-monitor/values.yaml:81-83`, `charts/betterdb-monitor/values.schema.json` (`properties.service`)
- `charts/betterdb-monitor/templates/_helpers.tpl:33-38` (default image tag = `<appVersion>-no-ai`)
- `charts/betterdb-monitor/README.md` ("Releasing the chart (maintainers)")
- `docs/updating.md:103-134`, `:177-187`; `docs/install/kubernetes.md:151-156`
- Failing publish run on `7d60dd14` (2026-11-10): `Chart.yaml appVersion (0.51.1) != apps/api/package.json (0.54.0)`
- Harness: `benchmarks/operator-sim/docs/VERSIONS.md`, `benchmarks/operator-sim/src/infra/betterdb.ts:80-96`, `benchmarks/operator-sim/config/sim.yaml` (`charts`, `betterdb`)
