# OpenEverest integration: research and plan

_Status: plan, 2026-11-24. Verified in code against OpenEverest core `v2.0.0-alpha.1` (main has identical monitoring code), provider-valkey v0.2.0, provider-sdk v0.4.0, `openeverest/hub`, and the plugin repos listed below._

_Implementation status: see [What shipped in the first PR](#what-shipped-in-the-first-pr) at the end._

## Goal

Get BetterDB **listed on the OpenEverest hub**, with an extension that **works today** on provider-valkey instances. Constraints:

- We do not modify CRs that provider-valkey owns.
- We do not go around OpenEverest's authorization.

## Decision

**Ship BetterDB as a generic plugin** (hub type `plugin`). It adds a "BetterDB" tab on Valkey instances. It gets credentials the same way the existing hub plugins do: the user's own token on the OpenEverest `/connection` API is the authorization check, and the plugin's own ServiceAccount then reads the instance's connection Secret. An in-cluster BetterDB agent connects to every Valkey node and streams to BetterDB Cloud or a self-hosted BetterDB.

**Add a monitoring `integration` listing later.** It becomes useful once provider-valkey publishes connection sources, which Sergey has confirmed is coming. Both listings can ship from the same chart and the same agent.

## Why a plugin and not a monitoring integration (verified)

| Route | Works with provider-valkey v0.2.0 today? | What BetterDB gets |
|---|---|---|
| Integration, connection-based (Coroot model: `requires.connection`) | **No.** Core reports it `Incompatible`: "no component satisfies the requirements of MonitoringClass" (`compat.go:204-206`). The valkey type declares only `metrics: Exporter`. | — |
| Integration, metrics-only (`requires.metrics`) | Yes: eligible (`compat.go:226-247`). | Only the redis_exporter endpoint over http, with no credentials. No slowlog, COMMANDLOG, CLIENT LIST or ACL LOG. Binding adds an exporter sidecar and rolls the pods. That isn't the BetterDB product. |
| **Generic plugin** | **Yes.** | Real credentials and TLS material for each instance, so BetterDB works in full. No pod restarts and no CR changes. |

Facts behind this:

- **Requirements are all-or-nothing.** A class's requirements are plain booleans (`monitoringclass_types.go:163-180`). There is no "optional" or "preferred" connection, so a class can't fall back to metrics.
- **Coroot is listed but works with no released provider today.** No provider in the hub declares `connection:` or `podMetadata:` on its default branch. The hub doesn't check that an extension works.
- **What the hub CI checks:** schema validation, directory, name and type, README, icon, and `helm show chart` for the chart reference (`verify-charts.sh:227`).
- **Review is metadata only.** `PUBLISHING.md:65-66`: "A hub maintainer reviews for metadata accuracy and naming. There is no code review — the formula is a pointer, not code."
- **One type per formula.** A formula is a provider, a plugin or an integration (`formula-v1.json:222-226`). One chart can still back two formulas.
- **No field restricts a formula to an engine.** `supportedEngines` exists only on providers. Valkey scoping happens in the Plugin CR (`extensionPoints[].providers: [valkey]`), through keywords, and in the README.

## Precedent: existing hub plugins that use database credentials (verified)

| Plugin | How it gets credentials |
|---|---|
| plugin-mongodb-explorer (`backend/main.go:145-157`) | `GET …/instances/{i}/connection` with the user's forwarded JWT |
| plugin-bench (`internal/everest/client.go:157`) | Same |
| plugin-migrations (`everest/client.go:123`) | Same |
| **plugin-user-management v0.2.8** (includes a Valkey engine) | Calls `/connection` with the user's JWT **as the authorization check** ("whoever can read the instance's admin credentials can already manage its users"). Its own ServiceAccount then reads `<inst>-conn` directly through a cluster-wide ClusterRole (`charts/.../rbac.yaml:9-31`, `engine/valkey/cluster.go:150-164`). |

We copy plugin-user-management's pattern for credentials. Unlike it, we never write the ValkeyCluster: it server-side-applies `spec.acl.users`, and we don't.

## Platform facts we build on (verified)

- **Connection API.** `GET /v1/clusters/{c}/namespaces/{ns}/instances/{i}/connection` (`http-api.yaml:1474`) returns type, provider, host, port, username, password, uri and any extra keys. It reads the Secret named by `Instance.status.connectionSecretRef` (`handlers/k8s/instance.go:117-139`). Access needs the explicit `read-connection` RBAC action. Plain `read` doesn't imply it (`pkg/rbac/rbac.go:196-197`).
- **Plugin proxy.** `/v1/plugins/{name}/*` is a plain reverse proxy (`internal/server/plugins.go:107-163`). It forwards the user's `Authorization: Bearer` header unchanged.
  - Spec 003 describes an `X-Everest-User` header, but it isn't implemented.
  - Plugin service tokens aren't implemented either: `plugintoken.Service.Mint` has no callers, and spec 003 §10.4 puts them in Phase 3. A plugin has **no daemon identity of its own** in OpenEverest. Background work runs under the plugin's Kubernetes ServiceAccount, which spec 003 allows ("trust is anchored at the plugin hub").
- **Events.** `GET /v1/clusters/{c}/events?watch=true` (SSE) carries Instance `Created/Updated/PhaseChanged/DeletionRequested/Deleted` events. It needs `read-events` and runs under a user token. We watch Instances through our own ServiceAccount instead.
- **provider-valkey connection Secret `<inst>-conn`** (`valkeycluster.go:265-314`, `tls.go:66-68`):
  - Always present: `type=valkey`, `provider`, `host` (the primary or headless `*.svc.cluster.local`), `port=6379`, `username=default`, `password`, `uri` (`redis://` or `rediss://`).
  - When TLS is on: `ssl=true` and `ca.crt`.
  - When client certificates are accepted: `tls.crt` and `tls.key`.
  - The runtime sets `status.connectionSecretRef` and the condition `ConnectionDetailsReady`.
  - These are **admin (`default`) credentials**. provider-valkey has no monitor user yet.
- **provider-valkey topology.**
  - Always a `ValkeyCluster` with `cluster-enabled yes`, one component `engine`, container `server`.
  - TLS is on by default, and then the cluster is TLS-only on 6379.
  - The server certificate's SANs are the headless FQDN with a `*.` wildcard, the primary Service and localhost. Pod IPs are **not** in the SANs.

## Design

### Components (one chart: `betterdb-openeverest`, Apache-2.0)

1. **Plugin CR** (`extensions.openeverest.io/v1alpha1`, `Plugin`):
   - `clusterDetailTab` "BetterDB", `providers: [valkey]`.
   - `settingsPanel` "BetterDB", for the BetterDB URL and agent token.
   - The backend runs in-cluster through `serviceRef`.
2. **Frontend**: an ESM bundle built from `openeverest/generic-plugin-template`, using MUI and `@openeverest/plugin-theme`. Spec 003 rules out iframes.
   - The tab shows the monitoring state for this instance: Off, Connecting, Monitoring, or an error.
   - An **Enable / Disable** button.
   - A short native summary: ops/sec, memory, clients, top slow commands.
   - A deep link to the connection in BetterDB.
   - Settings: URL, which is BetterDB Cloud `wss://<ws>.app.betterdb.com/agent/ws` or a self-hosted `wss://<host>/api/agent/ws`, and the agent token. The token is stored in a Secret in the plugin namespace.
3. **Backend + agent**: one Deployment running a new `openeverest` mode of the `betterdb/agent` image. The image is TypeScript/Node and reuses `packages/agent`. The backend runs four flows:
   - **Enable:** `POST /v1/plugins/betterdb/instances/{c}/{ns}/{i}/enable`.
     1. Call `/connection` with the forwarded JWT. That is the authorization check: a 403 means the user can't enable monitoring.
     2. Record the opt-in in the plugin's own state: a `betterdb-targets` ConfigMap in the plugin namespace.
     3. Start monitoring.
   - **Run:** for each opted-in instance:
     1. Read `status.connectionSecretRef` → `<inst>-conn` through the plugin ServiceAccount. Re-read it when it changes, so password rotation is handled.
     2. Connect to `host:port` over TLS with `ca.crt`, plus the client certificate if one is present.
     3. Discover the nodes with `CLUSTER SHARDS` and open **one connection per node** by IP, checking that the CA signed the certificate but not the hostname. Cluster redirects are disabled.
     4. Stream to BetterDB with identity labels: cluster, namespace, instance, node.
   - **Lifecycle:** watch `instances.core.openeverest.io` through the ServiceAccount, and drop targets when an instance is deleted.
   - **Status:** `GET …/status` feeds the tab.
   - **Disable:** removes the opt-in and closes the connections.
4. **RBAC** (shipped by the chart, the same as plugin-user-management):
   - `instances` get/list/watch.
   - `secrets` get/list/watch, cluster-wide or limited by `watchNamespaces`.
   - `configmaps` get/update in the plugin namespace.
   - No write access to any database CR.

### Credential posture

- **Today: admin credentials.** We use the `default` admin credentials from `<inst>-conn` because that is all provider-valkey publishes. On these connections BetterDB runs in **read-only mode**: by default it doesn't issue `CLIENT KILL`, `LATENCY RESET`, `COMMANDLOG RESET` or `CONFIG SET`. The README and the formula say so plainly.
- **Later: the read-only `monitor` profile.** When provider-valkey publishes `credentials[{profile: monitor}]` with connection sources, the agent switches to it. The ACL we will propose is in the appendix.

### Deployment topologies

| Where BetterDB runs | Agent dials |
|---|---|
| BetterDB Cloud | `wss://<workspace>.app.betterdb.com/agent/ws` |
| Self-hosted Docker, outside the cluster | `wss://<monitor-host>/api/agent/ws`, which must be reachable from the cluster |
| Self-hosted `betterdb-monitor` chart, same cluster | The Monitor Service's in-cluster `/api/agent/ws` |

## Work breakdown

### 1. Agent (`packages/agent`): `openeverest` mode

- **Plugin backend HTTP server:** enable, disable and status, with JWT pass-through to `/connection`.
- **Target store** in the ConfigMap. **Instance watch** and **Secret watch** through the ServiceAccount.
- **Multiple targets** in one process. **Per-node cluster connections** with no redirects.
- **TLS:**
  - CA, client certificate and key from the Secret.
  - Verify-chain-only, without a hostname check.
  - `BETTERDB_CA_FILE` so the agent trusts a self-hosted Monitor that uses a private CA.
- **Identity labels** and a **read-only mode** flag sent to the server.
- **Images:** multi-arch, versioned tags.

### 2. Monitor server (the same code ships as the Docker image and in the `betterdb-monitor` chart)

- **Stable identity for agent connections**, such as cluster id + namespace + instance + node. Today agent connections aren't persisted (`proprietary/agent/agent-gateway.ts`), and history must survive agent restarts and failovers.
- **Grouping** by OpenEverest instance: cluster → namespace → instance → nodes.
- **Read-only mode** on agent connections: hide or disable the actions that change state. Also degrade per feature on `NOPERM`, ready for the later monitor profile.
- **A "Connect OpenEverest" screen** in self-hosted and Cloud. It issues an agent token (`POST /agent-tokens`, `type: agent`) and shows the `helm install` command.
- **Small summary endpoint** for the plugin tab, authenticated with the agent token.
- **Check cluster topology and slot metrics** when each node arrives as a separate agent target.

### 3. Plugin repo: `betterdb/openeverest-betterdb` (Apache-2.0, DCO-signed commits)

- Frontend from `generic-plugin-template`: tab and settings panel.
- Chart `charts/betterdb-openeverest/`: Plugin CR, backend/agent Deployment, Service, ServiceAccount, ClusterRole, settings Secret.
- Values: `betterdb.url`, `betterdb.token` or `betterdb.existingSecret`, `betterdb.caFile`, `watchNamespaces`.
- Tests: an end-to-end run on k3d with OpenEverest alpha.1 and provider-valkey v0.2.0 (TLS on and off, replication and cluster topologies), against a self-hosted `betterdb-monitor` and against Cloud.

### 4. Publishing and the hub listing

- **OCI:** add `helm push` to `oci://ghcr.io/betterdb/charts` in `.github/workflows/helm-publish.yml`. Today it publishes only a classic `helm repo index` to `docs.betterdb.com/charts`. Do it for `betterdb-openeverest`, and for `betterdb-monitor` too, since it costs little.
- **Hub formula PR** at `extensions/plugins/betterdb/`, containing `formula.yaml`, `README.md` and an icon:
  - `metadata.license: Apache-2.0`, `access: public`, `maturity: alpha`, `maintainers[].github`.
  - `spec.plugin.contributes{ui: true, backend: true}` plus `extensionPoints` (`clusterDetailTab`, `settingsPanel`).
  - `keywords: [valkey, redis, monitoring, observability]`.
  - `install.helm{namespace: everest-system}`.
  - Prerequisites: a BetterDB Cloud workspace or a self-hosted BetterDB (Docker or the `betterdb-monitor` chart).
  - README: Valkey only; uses admin connection credentials in read-only mode; needs the `read-connection` permission to enable; no pod restarts.
- **Check the plugin formula fields** against `schemas/formula-v1.json:293-318` and `extensions/_template` before opening the PR.

### 5. `betterdb-monitor` chart and Docker docs

- Check that the ingress passes WebSocket upgrades on `/api/agent/ws` (nginx `proxy-read-timeout`/`proxy-send-timeout`), and add a values example.
- Document the Docker-only self-hosted setup: the Monitor must be reachable over `wss`, with a public certificate or a CA passed to the agent.

### 6. Later: the monitoring `integration` listing

When provider-valkey declares `connection: Supported` and publishes `connections[]` and `credentials[{profile: monitor}]`:

- **New class.** Add a `betterdb` MonitoringClass (ExtensionManaged, `requires{connection: true, kinds: [valkey]}`) and a small class controller **to the same chart**. Skip `podMetadata`: the agent gets its targets from `Instance.status.monitoring.sources` through the ServiceAccount, so no pods roll.
- **Second formula.** List it under `extensions/integrations/betterdb/`. BetterDB then also appears in OpenEverest's native Monitoring step.
- **Switch credentials.** Move the agent to the monitor credential profile for bound instances.

## Sequencing

| Step | What | Depends on |
|---|---|---|
| 0 | Reply to Sergey: tell him we're listing a plugin now and an integration later. | — |
| 1 | Agent `openeverest` mode | — |
| 2 | Monitor: stable agent identity, grouping, read-only mode, Connect screen, summary endpoint | — |
| 3 | Plugin repo: frontend and chart | — |
| 4 | End-to-end on k3d with alpha.1 and provider-valkey v0.2.0 | 1–3 |
| 5 | OCI publish and **hub plugin formula PR** | 4 |
| 6 | Integration class and second formula | provider-valkey connection sources |

Steps 1–3 run in parallel, and none of them waits on upstream.

## Risks

- **Admin credentials.**
  - **Risk:** the agent holds the `default` password until provider-valkey ships a monitor user.
  - **Mitigation:** read-only mode on our side, enforced in both the agent and the Monitor, and stated plainly in the README. Enabling requires `read-connection`, which already implies the user can see these credentials.
- **Plugin ServiceAccount reads Secrets cluster-wide.**
  - **Risk:** plugin-user-management needs the same, so there is precedent.
  - **Mitigation:** offer `watchNamespaces` to narrow it.
- **No plugin daemon identity in OpenEverest.**
  - **Risk:** the opt-in happens with a user token, but continuous monitoring runs under our ServiceAccount.
  - **Mitigation:** this is the plugin-user-management model and acceptable under spec 003. Revisit when Phase 3 service tokens ship.
- **TLS rework (provider-valkey #49 / core #3707).** The CA location and TLS options will move. We always read the CA from `<inst>-conn` (`ca.crt`), which #49 says stays.
- **Alpha churn.**
  - **Risk:** specs 003 and 007 are Draft. Open hub PR #124 may remove `spec.compatibility`. Contract versioning (#3700–#3706) is in flight.
  - **Mitigation:** pin to alpha.1 and re-check at each release.
- **Hub review is metadata-only.**
  - **Risk:** maintainers will judge the formula, the README and the RBAC claims.
  - **Mitigation:** be explicit about Secret access and the use of admin credentials.

## Draft reply to Sergey

> Gotcha, thanks! Plan: we'll ship BetterDB as a generic plugin first. It adds a BetterDB tab on Valkey instances, the user enables it with their own `read-connection` permission, and an in-cluster agent streams to BetterDB Cloud or self-hosted. It follows the plugin-user-management credential pattern and never touches the ValkeyCluster. No pod restarts either. We'll send the hub formula once it's tested on alpha.1. When provider-valkey publishes connection sources and a monitor credential, we'll add a `betterdb` MonitoringClass to the same chart and list it as an integration too. Happy to propose the monitor ACL for that.

## Appendix: proposed `monitor` ACL (for the integration phase)

These are the commands BetterDB sends on its read-only monitoring path, taken from `apps/api/src` and `packages/*/src`:

```
+@connection +ping +info +role +time +config|get +command|info +module|list +function|list
+client|list +client|info
+slowlog|get +slowlog|len +commandlog|get +commandlog|len
+latency|latest +latency|history +latency|doctor
+memory|stats +memory|doctor +memory|usage
+cluster|info +cluster|nodes +cluster|shards +cluster|slots +cluster|getslotmigrations
+acl|log +acl|users +acl|whoami
+dbsize +scan +type +ttl +pttl +object|encoding +object|freq +object|idletime
~*
```

Before proposing it, validate it against Valkey 9.0/9.1 command names.

## What shipped in the first PR

Branch `feat/openeverest-plugin`, in this monorepo rather than a separate plugin repo: one place for the agent, the chart and the frontend. The chart and the frontend package are Apache-2.0 on their own.

| Area | Shipped | Where |
|---|---|---|
| Agent `openeverest` mode | Plugin backend (enable / disable / status, settings, `/main.js`), ConfigMap opt-in store, Instance and Secret informers through the ServiceAccount, per-node connections with no redirects, chain-only TLS, `BETTERDB_CA_FILE`, identity labels and read-only in the hello | `packages/agent/src/openeverest/` |
| Monitor server | Connection id derived from identity labels (`agent-openeverest-<hash>`), read-only enforced in `AgentDatabaseAdapter` on every command, `readOnly` on the connection status | `proprietary/agent/`, `packages/shared/src/types/{agent-protocol,command-safety}.ts` |
| Frontend | ESM bundle, `clusterDetailTab` (valkey only) and `settingsPanel`, built into the `betterdb/agent` image | `packages/openeverest-plugin/` |
| Chart | Plugin CR, Deployment, Service, ServiceAccount, ClusterRole or per-namespace Roles, state Role, settings Secret; helm-unittest suites | `charts/betterdb-openeverest/` |
| Publishing | `helm-publish-oci.yml` pushes to `oci://ghcr.io/betterdb/charts` (both charts) | `.github/workflows/` |
| Docs and hub | Install guide, draft formula + README validated against `formula-v1.json` | `docs/install/openeverest.md`, `charts/betterdb-openeverest/hub/` |

Facts learned while implementing that correct the plan above:

- The plugin proxy base is `/v1/clusters/{cluster}/plugins/{name}`, not `/v1/plugins/{name}`, and the backend sees bare paths (`/api/...`, `/main.js`, `/healthz`). GET requests are **not** authenticated at the proxy; POST/PUT/DELETE need a session and `use` on the plugin. The backend therefore serves nothing sensitive on GET and gates enable *and* disable on the `/connection` check.
- `providers` scoping lives on the extension point (in the CR's `frontend.extensionPoints[]` and in `registerExtension`), not at the top of the Plugin spec. The tab props carry `instanceName` and `namespace`; the cluster name comes from `api.basePath`.
- `status.connectionSecretRef` is an object `{name}`. provider-valkey always runs `cluster-enabled yes`, so per-node discovery is the only path; the agent's single-node fallback is for other sources.
- Node identity uses the Valkey cluster node id (stable in `nodes.conf` on the volume), with the pod name from reverse DNS for display. Pod IPs change on restart, so they are not part of the identity.
- Connection ids are scoped by the agent token's **name**, not its id: tokens have no owner today, and the name is the handle an admin controls. Rotating a token under the same name keeps the ids; a token under another name cannot take a node over. Identities are validated on arrival and capped at 512 per token.
- Read-only connections redact `requirepass`, `masterauth`/`primaryauth` and the TLS passphrases in `CONFIG GET` replies (agent and Monitor both), rather than denying `CONFIG GET`, so the Monitor's own config reads keep working.

### TODO (out of scope of the first PR)

- **UI grouping by OpenEverest instance** in the Monitor app (cluster → namespace → instance → nodes). The identity labels are on `AgentConnectionInfo` already; the connections list shows one entry per node named `namespace/instance/pod`.
- **Hide or disable state-changing actions** in the Monitor UI for `readOnly` connections. The server refuses them today; the UI still shows the buttons and surfaces the error.
- **"Connect OpenEverest" screen** in self-hosted and Cloud: issue the agent token and print the `helm install` command.
- **Summary endpoint** for the plugin tab (ops/sec, memory, clients, top slow commands), authenticated with the agent token. The tab shows connection state only.
- **Cluster topology and slot metrics** when each node arrives as a separate agent target: check what the cluster pollers do with per-node agent connections.
- **MonitoringClass integration** and the second hub formula, once provider-valkey publishes connection sources and a monitor credential.
- **Monitor profile ACL**: validate the appendix against Valkey 9.0/9.1 command names before proposing it.
- **E2E in CI.** `scripts/openeverest-e2e.sh` passes locally on kind (Kubernetes 1.32, OpenEverest 2.0.0-alpha.1, provider-valkey 0.2.0: a TLS 3-shard instance, 6 nodes streaming read-only, removed on disable). It is not wired into a workflow yet; it needs docker + kind and about 15 minutes.
- **Settings are not editable from the UI.** Any OpenEverest user with a session could otherwise repoint every agent to their own server, and the plugin backend has no admin check to call. The URL and token come from the chart (values or `existingSecret`) only; the NetworkPolicy limits ingress to everest-server. Revisit if OpenEverest grows plugin service tokens or an admin check.
