# Allow webhooks to reach private-network receivers through an explicit allowlist

**Suggested labels:** `enhancement`, `webhooks`, `security`, `kubernetes`, `helm`  ·  **Area:** `apps/api/src/webhooks`, `apps/api/src/common/utils`, `charts/betterdb-monitor`, `docs`  ·  **Severity:** medium (self-hosted installs cannot send alerts to a receiver on their own network at all, and there is no setting that allows it)

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

Every official deployment runs with `NODE_ENV=production`: the Docker image sets it, so the Helm chart and Docker Compose do too. In that mode, webhook URLs that point at a private, loopback or link-local address are rejected, as are hostnames that resolve to one. The check runs when a webhook is created or updated, and again at delivery time. That is the right default against server-side request forgery (SSRF: getting the server to call internal endpoints for an attacker). But it also means a self-hosted BetterDB cannot deliver to a receiver in its own cluster or VPC, such as `http://alert-relay.monitoring.svc.cluster.local/hook`, an n8n instance, or a self-hosted chat server. The guard already supports `allowPrivateNetworks`, and the KV-cache metrics scraper already uses it, but the webhook paths never pass it and no setting turns it on. This issue proposes an explicit allowlist (CIDRs and hostnames) that is empty by default, ignored in cloud mode, applied the same way at create, update, test and delivery, and never able to unblock cloud metadata endpoints.

## How we found it

The `benchmarks/operator-sim` harness in this repo runs a Valkey cluster on Kubernetes, injects faults, and measures how long BetterDB takes to report them. The plan was to measure detection latency with an in-cluster webhook receiver.

- kind v0.33.0, Kubernetes v1.37.0. BetterDB Monitor v0.55.0 (image `betterdb/monitor:0.55.0-no-ai`, Helm chart 0.51.1 with the image tag overridden), Enterprise license, so every webhook event tier was available.
- The receiver would have been a Service in the harness namespace (`http://<svc>.operator-sim.svc.cluster.local/...`), which resolves to a pod IP in `10.244.0.0/16`.
- Creating that webhook was not possible, and no environment variable allowed it. The harness fell back to polling the REST API every 5 s instead (`benchmarks/operator-sim/docs/DECISIONS.md`, D18), so its latency figures are only accurate to ±5 s.

## Observed behaviour

With `NODE_ENV=production` (`Dockerfile:227`):

| Webhook URL | Create / update | Delivery (if it had been stored) |
|---|---|---|
| `http://10.244.1.7:8080/hook` (IP literal) | `400 Cannot use private IP addresses as webhook URL` | — |
| `http://receiver.operator-sim.svc.cluster.local/hook` (resolves to 10.x) | `400 Webhook URL resolves to a blocked address` | blocked by the connect-time lookup (`BlockedAddressError`) |
| `http://localhost:9000/hook` | `400 Cannot use localhost or 0.0.0.0 as webhook URL in production` | — |
| `http://169.254.169.254/latest/meta-data/` | `400 Cannot use private IP addresses as webhook URL` | — |

No environment variable, chart value or per-webhook option changes this.

Outside production (local `pnpm dev`) the behaviour is uneven:
- Private **IP literals** are still rejected, because the check at `outbound-url-guard.ts:105` does not depend on `NODE_ENV`.
- **Hostnames** that resolve to private IPs are accepted, because DNS is checked only in production (`resolveDns: 'production'`).
- Delivery skips the lookup guard entirely.

The same happens on v0.55.0 and on origin/master (7b29d758). The relevant files are unchanged between them.

## Expected behaviour

- The default stays as it is: production rejects private, loopback and link-local targets.
- An operator can explicitly allow specific private ranges or hostnames for webhooks, for example the cluster's pod and Service CIDRs, or `*.svc.cluster.local`.
- Whatever is allowed is enforced identically at create, update, `POST /api/webhooks/:id/test` and every delivery or retry, so a webhook that saves always delivers (and the reverse).
- Cloud metadata and link-local addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200`, `192.0.0.192`) can never be allowed.
- In cloud mode (`CLOUD_MODE`) the allowlist is ignored and a warning is logged.

## Root cause

`apps/api/src/common/utils/outbound-url-guard.ts` already distinguishes "private" from "always blocked":

```ts
// :28
const ALWAYS_BLOCKED = [/^169\.254\./, /^fe[89ab][0-9a-f]:/i, /^fd00:ec2::254$/, /^100\.100\.100\.200$/, /^192\.0\.0\.192$/];
// :66-71
export function isBlockedIp(ip: string, allowPrivateNetworks = false): boolean {
  const address = unmapIpv4(canonicalIp(ip));
  if (ALWAYS_BLOCKED.some((pattern) => pattern.test(address))) return true;
  if (allowPrivateNetworks) return false;
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(address));
}
```

`assertSafeOutboundUrl` (`:78-137`) and the connect-time `guardedLookup` (`:139-158`) both accept `allowPrivateNetworks`. The webhook code never passes it:

- `apps/api/src/webhooks/webhooks.service.ts:83` (create) and `:168` (update):
  ```ts
  await assertSafeOutboundUrl(dto.url, { label: 'webhook URL', resolveDns: 'production' });
  ```
- `apps/api/src/webhooks/webhook-dispatcher.service.ts:754-757`, used by real deliveries (`:807`) and by the test endpoint (`:1006`):
  ```ts
  const lookup = process.env.NODE_ENV === 'production' ? guardedLookup({ label: 'webhook URL' }) : undefined;
  return pinnedRequest(url, { method: 'POST', headers, body, signal, lookup });
  ```
  `pinnedRequest` (`apps/api/src/common/utils/pinned-request.ts`) connects to the address the guarded lookup returned and does not follow redirects. This already protects against DNS rebinding, where a name resolves to a public IP when it is checked and to a private IP when the request is sent.

The KV-cache scraper sets a precedent: `proprietary/kv-cache/metrics-fetch.ts:33-53` allows private targets by default when self-hosted, blocks them when `KV_CACHE_SCRAPE_BLOCK_PRIVATE` is set, always blocks them in cloud mode, and passes the result to both the URL check (`:81`) and the connect-time lookup (`:22`). Webhooks have no equivalent.

`allowPrivateNetworks: true` is too broad for webhooks as it stands: it also allows loopback (`:96-99`, `:144-145`), and that would let a webhook call BetterDB's own API on `127.0.0.1:3001` or another sidecar.

## Proposed change

### Configuration (env, with secure defaults)

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_ALLOWED_PRIVATE_CIDRS` | _(empty)_ | Comma-separated CIDRs (IPv4/IPv6), e.g. `10.244.0.0/16,10.96.0.0/12`. A resolved webhook address inside one of them is accepted even though it is private. |
| `WEBHOOK_ALLOWED_PRIVATE_HOSTS` | _(empty)_ | Comma-separated hostnames, exact (`relay.internal`) or suffix wildcards (`*.svc.cluster.local`). For a URL whose hostname matches, any **private** address it resolves to is accepted. |

Rules:
1. `ALWAYS_BLOCKED` addresses (metadata / link-local) are rejected whatever the lists contain. A CIDR that overlaps them (for example `169.254.0.0/16` or `0.0.0.0/0`) is refused at startup with a clear error. Do not trim it silently.
2. Loopback (`127.0.0.0/8`, `::1`) and `0.0.0.0/8` are accepted only if listed explicitly as a CIDR. `*` alone is not a valid host pattern.
3. Public addresses are always accepted, as today.
4. If `CLOUD_MODE` is on, both variables are ignored and a warning is logged at startup.
5. Invalid entries fail startup through `env.schema.ts` validation. A typo must not end up as an "allow nothing" or "allow everything" list.

A boolean such as `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` was considered and rejected. It is too easy to set without thinking, and it would let a webhook reach every internal service. If maintainers want it as a convenience anyway, it should expand to the RFC 1918, CGNAT and ULA ranges only, never loopback.

### Guard API (`outbound-url-guard.ts`)

Replace the boolean with a policy object (keep the boolean for existing callers):

```ts
export interface PrivateNetworkPolicy {
  /** Built once from env with net.BlockList (addSubnet). */
  allowedCidrs?: BlockList;
  /** Lower-cased exact names and '*.suffix' patterns. */
  allowedHosts?: string[];
}
export interface OutboundUrlOptions {
  label: string;
  allowPrivateNetworks?: boolean;        // existing, unchanged meaning
  privateNetworkPolicy?: PrivateNetworkPolicy;
  resolveDns?: 'always' | 'production' | 'never';
}
```

`isBlockedIp(ip, policy, hostname)` becomes: ALWAYS_BLOCKED → blocked. Otherwise private or loopback and (in `allowedCidrs`, or `hostname` matches `allowedHosts` and the address is private but not loopback) → allowed. Otherwise private → blocked. Otherwise allowed. `guardedLookup` gets the same policy and checks every resolved address, as it does now.

### Webhooks

- New `webhookNetworkPolicy()` in `apps/api/src/webhooks/` (built once from config, like `scrapeAllowsPrivateNetworks`). It is passed at `webhooks.service.ts:83` and `:168` and in `webhook-dispatcher.service.ts` `post()` (`:754-757`).
- When a policy is configured, `post()` should always pass a guarded lookup, not only in production, so dev and prod behave the same.
- Error messages: when a URL is rejected only because it is private and not cloud mode, append "allow it with WEBHOOK_ALLOWED_PRIVATE_CIDRS or WEBHOOK_ALLOWED_PRIVATE_HOSTS (see docs/webhooks.md)". The web form shows the API message unchanged.
- Existing webhooks: if the allowlist shrinks, deliveries to now-blocked targets fail with `BlockedAddressError` and are recorded as failed deliveries. Log one warning per webhook, not one per delivery.

### Helm chart (`charts/betterdb-monitor`)

```yaml
webhooks:
  # Private ranges/hostnames webhooks may deliver to. Empty = public receivers only.
  allowedPrivateCidrs: []      # e.g. ["10.244.0.0/16", "10.96.0.0/12"]
  allowedPrivateHosts: []      # e.g. ["*.svc.cluster.local"]
```

These render to the two env vars in `templates/deployment.yaml` only when non-empty. Add both to `values.schema.json` (arrays of strings, CIDRs validated by pattern) and to the chart README.

### Docs

- `docs/webhooks.md`: a new "Receivers on a private network" section covering the default behaviour, the two variables, examples for Kubernetes (pod and Service CIDRs, or `*.svc.cluster.local`) and Docker (`172.17.0.0/16`), the fact that metadata addresses stay blocked, and that the allowlist is ignored in cloud mode.
- `docs/configuration.md`: add both variables to the environment table, next to `WEBHOOK_TIMEOUT_MS` and the related variables.

### Security trade-offs (for reviewers)

- **SSRF reach:** anyone who can create webhooks can make BetterDB POST to anything in the allowlist. Creating webhooks already needs an authenticated admin session, but the docs should recommend the narrowest CIDR or host that works.
- **DNS rebinding:** covered because the connect-time `guardedLookup` checks the address that is actually dialled, and redirects are not followed (`pinnedRequest`). Hostname allowlisting is safe only for names whose DNS the operator controls (cluster DNS, private zones). The docs should say so.
- **Metadata endpoints:** stay blocked by `ALWAYS_BLOCKED`. Reviewers may want to add other provider metadata addresses (e.g. Azure wireserver `168.63.129.16`, which is a public-range IP) to `ALWAYS_BLOCKED` for all callers. That is a separate change.
- **Loopback:** blocked unless explicitly listed, so a webhook cannot reach BetterDB's own API or a sidecar by accident.

## Acceptance criteria

- [ ] With both variables unset, behaviour is identical to today (existing `outbound-url-guard.spec.ts`, `webhooks.service.spec.ts` and `webhook-dispatcher.service.spec.ts` pass unchanged).
- [ ] With `WEBHOOK_ALLOWED_PRIVATE_CIDRS=10.244.0.0/16` in production: creating `http://10.244.1.7/hook` succeeds, and creating `http://10.245.0.1/hook` fails with 400.
- [ ] With `WEBHOOK_ALLOWED_PRIVATE_HOSTS=*.svc.cluster.local`: a URL whose host matches and resolves to `10.96.0.10` succeeds at create, test and delivery. `evil.example.com` resolving to `10.96.0.10` fails.
- [ ] `169.254.169.254`, `fd00:ec2::254` and a hostname resolving to `169.254.169.254` are rejected even with `WEBHOOK_ALLOWED_PRIVATE_CIDRS=0.0.0.0/0`. In fact `0.0.0.0/0` and `169.254.0.0/16` are refused at startup.
- [ ] `http://127.0.0.1:3001/` is rejected unless `127.0.0.0/8` is listed.
- [ ] A hostname that resolves to an allowed address at create time and to a non-allowed private address at delivery time fails the delivery (rebinding test).
- [ ] With `CLOUD_MODE` set, both variables are ignored and a startup warning names them.
- [ ] Setting the chart values renders both env vars, and leaving them empty renders neither (`helm template` test).
- [ ] `docs/webhooks.md` and `docs/configuration.md` document both variables.

## Test plan

**Unit, `apps/api/src/common/utils/__tests__/outbound-url-guard.spec.ts`** (mock `dns.lookup`, `NODE_ENV=production`):

| URL | DNS answer | Policy | Expect |
|---|---|---|---|
| `http://10.244.1.7/` | — | cidrs `10.244.0.0/16` | resolves |
| `http://10.245.0.1/` | — | cidrs `10.244.0.0/16` | 400 private |
| `http://r.ns.svc.cluster.local/` | `10.96.3.4` | hosts `*.svc.cluster.local` | resolves |
| `http://evil.example.com/` | `10.96.3.4` | hosts `*.svc.cluster.local` | 400 blocked address |
| `http://r.ns.svc.cluster.local/` | `169.254.169.254` | hosts `*.svc.cluster.local` | 400 blocked address |
| `http://[::ffff:169.254.169.254]/` (IPv4-mapped) | — | cidrs `10.0.0.0/8` | 400 (always blocked) |
| — | — | cidrs `0.0.0.0/0` or `169.254.0.0/16` | policy parse throws (startup error) |
| `http://127.0.0.1:3001/` | — | cidrs `10.0.0.0/8` | 400 |

`guardedLookup` with the same policy: callback error for a blocked answer, address for an allowed one. If DNS returns a mix of allowed and blocked answers, the result is blocked (same rule as today).

**Unit, `webhooks.service.spec.ts` / `webhook-dispatcher.service.spec.ts`:** create, update and `testWebhook` all pass the same policy. `post()` passes a lookup whenever a policy is set.

**Chart:** `helm template t charts/betterdb-monitor --set webhooks.allowedPrivateCidrs='{10.244.0.0/16}' | grep -A1 WEBHOOK_ALLOWED_PRIVATE_CIDRS` → value `10.244.0.0/16`.

**Harness repro** (`benchmarks/operator-sim`, with a build of the branch: set `betterdb.buildRef` in `config/sim.yaml`):

```sh
cd benchmarks/operator-sim
make up betterdb warm
# deploy any HTTP echo receiver as Service "hook" in namespace operator-sim, then:
curl -s -X POST localhost:3001/api/webhooks -H 'content-type: application/json' \
  -d '{"name":"in-cluster","url":"http://hook.operator-sim.svc.cluster.local/","events":["anomaly.detected"]}'
```

Today this returns 400. With `WEBHOOK_ALLOWED_PRIVATE_HOSTS=*.svc.cluster.local` (added to `infra/betterdb/values.yaml` `extraEnv`, or to the new chart value) it returns 201. Then run `PHASES=spike make scenario` and check that the receiver logs one POST per anomaly event, with `X-Webhook-Event` set.

## Out of scope / open questions

- Per-webhook opt-in (an "internal receiver" flag on each webhook, which an admin must also enable globally) instead of, or as well as, the global list. The global env list is simpler and keeps the decision with whoever deploys BetterDB.
- Whether the dev-mode quirk (private IP literals rejected while private hostnames are accepted) should be fixed separately by checking both consistently in every mode.
- Whether other outbound callers (for example notification integrations added later) should share the same policy variable or have their own.

## References

- `apps/api/src/common/utils/outbound-url-guard.ts:15-158`
- `apps/api/src/webhooks/webhooks.service.ts:81-116`, `:165-180`
- `apps/api/src/webhooks/webhook-dispatcher.service.ts:754-757`, `:807`, `:940-1010`
- `apps/api/src/common/utils/pinned-request.ts`
- `proprietary/kv-cache/metrics-fetch.ts:21-53`, `:79-84` (existing opt-in precedent), `docs/kv-cache-monitoring.md` (`KV_CACHE_SCRAPE_BLOCK_PRIVATE`)
- `Dockerfile:227` (`ENV NODE_ENV=production`)
- `docs/webhooks.md`, `docs/configuration.md`
- Harness: `benchmarks/operator-sim/docs/DECISIONS.md` (D18)
