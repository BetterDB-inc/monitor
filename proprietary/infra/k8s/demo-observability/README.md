# Public demo observability — shared infra

This directory stands up the **one-time** Prometheus + Grafana stack behind the
public live demo:

- `https://demo-grafana.app.betterdb.com` — anonymous read-only Grafana with
  the shipped dashboard pack (`deploy/observability/dashboards/`).
- `https://demo.app.betterdb.com/api/prometheus/metrics` — the demo tenant's
  own scrape endpoint, reachable by visitors with the **published** demo token
  (`PROMETHEUS_METRICS_PUBLIC_TOKEN`, minted by the entitlement provisioner
  for the demo tenant).

OTLP is demonstrated **push-only**: the demo tenant mirrors its metrics over
OTLP into this Prometheus (native OTLP receiver). There is no public OTLP
ingest endpoint; Monitor's `/v1/traces` + `/v1/external/metrics` ingest is
documented but not exposed with a published credential.

## Architecture

```
visitor ──HTTPS──► shared tenant ALB ──► Grafana (anonymous Viewer)
                                              │ PromQL
                                              ▼
                 ┌─────────────────────► Prometheus (ClusterIP only, 24h retention)
   scrape /api/prometheus/metrics             ▲
   (primary metrics token)                    │ OTLP push /api/v1/otlp/v1/metrics
                 │                            │
                 └──── demo tenant pod ───────┘
                       (tenant-<demo-subdomain>, port 3001)

visitor's own Prometheus ──HTTPS──► demo.app.betterdb.com/api/prometheus/metrics
                                    (published PUBLIC token, WAF rate-limited)
```

Two token tiers on the same endpoint:

| Token | Who uses it | Rotation impact |
|---|---|---|
| `PROMETHEUS_METRICS_TOKEN` (primary) | This stack's Prometheus scrape | Internal only — update `demo-scrape-token` Secret here |
| `PROMETHEUS_METRICS_PUBLIC_TOKEN` | Published in the live-demo docs | Public only — docs need the new value; this stack is unaffected |

## Prerequisites

- The demo tenant provisioned by an entitlement release that mints
  `PROMETHEUS_METRICS_PUBLIC_TOKEN` and injects the OTLP mirror env
  (`provisioning.service.ts`, demo branch). For a pre-existing demo tenant,
  re-run provisioning or backfill the Secret/Deployment manually.
- `kubectl` pointed at the EKS cluster.
- The shared tenant ALB (AWS Load Balancer Controller) and the
  `*.app.betterdb.com` ACM certificate (terraform).
- No existing tenant owns a `demo-*` subdomain (`demo-*` is reserved for new
  registrations, but a tenant created before that rule would already hold an
  ingress rule for the host in the same ALB group — check
  `kubectl get ingress -A | grep demo-` before applying).

## Install

The manifests carry placeholders (`tenant-DEMO_SUBDOMAIN`, `ACM_CERT_ARN`,
`ALB_GROUP_NAME`). Stream the substitution into `kubectl` — never `sed -i` —
so the tracked files stay pristine and re-runnable:

### 1. Set the environment-specific values

```bash
DEMO_SUBDOMAIN=<the demo tenant's subdomain>          # namespace is tenant-$DEMO_SUBDOMAIN
ACM_CERT_ARN=<arn of the *.app.betterdb.com cert>     # same as entitlement ACM_CERT_ARN
ALB_GROUP_NAME=<current tenant ALB group>             # same as entitlement ALB_GROUP_NAME
```

### 2. Namespace, quota, network policies

```bash
sed "s/tenant-DEMO_SUBDOMAIN/tenant-$DEMO_SUBDOMAIN/g" namespace.yaml | kubectl apply -f -
```

### 3. Secrets

```bash
# Scrape credential = the demo tenant's PRIMARY metrics token.
TOKEN=$(kubectl get secret db-credentials -n tenant-$DEMO_SUBDOMAIN \
  -o jsonpath='{.data.PROMETHEUS_METRICS_TOKEN}' | base64 -d)
kubectl create secret generic demo-scrape-token -n demo-observability \
  --from-literal=token="$TOKEN"

# Grafana operator login (anonymous visitors never see it).
kubectl create secret generic grafana-admin -n demo-observability \
  --from-literal=password="$(openssl rand -base64 24)"
```

### 4. Dashboards

The shipped pack is provisioned as-is — no fork of the JSON:

```bash
kubectl create configmap grafana-dashboards -n demo-observability \
  --from-file=../../../../deploy/observability/dashboards/
```

### 5. Prometheus + Grafana

```bash
sed "s/tenant-DEMO_SUBDOMAIN/tenant-$DEMO_SUBDOMAIN/g" prometheus.yaml | kubectl apply -f -
sed -e "s|ACM_CERT_ARN|$ACM_CERT_ARN|" -e "s/ALB_GROUP_NAME/$ALB_GROUP_NAME/" grafana.yaml | kubectl apply -f -
```

### 6. DNS + WAF (terraform)

Both live in `proprietary/infra/terraform/demo-observability.tf`. The WAFv2
ACL (rate limits for the published scrape endpoint and the Grafana host) is
created unconditionally; only the DNS record is gated behind `demo_dns_enabled`,
because it looks up the controller-created ALB. Set the flag in
`terraform.tfvars` — a transient CLI `-var` means the next plain apply plans
destruction of the DNS record. Also set `demo_tenant_subdomain` to the demo
tenant's registered subdomain so the metrics WAF rule covers both of the demo
pod's hostnames:

```bash
cat >> terraform.tfvars <<EOF
demo_dns_enabled      = true
demo_tenant_subdomain = "$DEMO_SUBDOMAIN"   # the demo tenant's REAL registered subdomain, NOT "demo"
EOF
terraform apply
```

`demo_tenant_subdomain` must be the demo tenant's registered subdomain (the
same `$DEMO_SUBDOMAIN` from step 1) — terraform rejects `demo`/`demo-*` because
those are reserved and would leave the real host un-rate-limited.

Then attach the WAF ACL to the shared ALB via the ingress annotation (the ALB
controller owns WAF association, so it must come from an ingress, not
terraform):

```bash
kubectl annotate ingress grafana -n demo-observability \
  "alb.ingress.kubernetes.io/wafv2-acl-arn=$(terraform output -raw tenant_alb_waf_acl_arn)"
```

### 7. Publish the scrape token (launch checklist)

Do this ONLY after step 6 — the WAF attachment is what makes a published
credential safe:

```bash
kubectl get secret db-credentials -n tenant-$DEMO_SUBDOMAIN \
  -o jsonpath='{.data.PROMETHEUS_METRICS_PUBLIC_TOKEN}' | base64 -d
```

Publish the value on the betterdb.com live-demo page (the surface
`docs/live-demo.md` points visitors at). Rotations (below) must update it in
the same place.

## Runbooks

> **Rotation downtime:** the tenant Deployment is single-replica with
> strategy `Recreate`, so any rollout restart takes the demo (UI, metrics
> endpoint, OTLP mirror) down for the pod kill + image pull + boot window —
> typically well under a minute, but visible. Rotate in a low-traffic window.

### Rotate the published (public) scrape token

```bash
kubectl patch secret db-credentials -n tenant-$DEMO_SUBDOMAIN --type=merge \
  -p "{\"stringData\":{\"PROMETHEUS_METRICS_PUBLIC_TOKEN\":\"$(openssl rand -hex 32)\"}}"
kubectl rollout restart deployment/betterdb -n tenant-$DEMO_SUBDOMAIN
# Then update the token on the betterdb.com live-demo page (step 7 above).
```

This stack keeps scraping throughout — it uses the primary token.

### Rotate the primary scrape token

```bash
kubectl patch secret db-credentials -n tenant-$DEMO_SUBDOMAIN --type=merge \
  -p "{\"stringData\":{\"PROMETHEUS_METRICS_TOKEN\":\"$(openssl rand -hex 32)\"}}"
kubectl rollout restart deployment/betterdb -n tenant-$DEMO_SUBDOMAIN
# Mirror the new value into this namespace:
kubectl delete secret demo-scrape-token -n demo-observability
TOKEN=$(kubectl get secret db-credentials -n tenant-$DEMO_SUBDOMAIN \
  -o jsonpath='{.data.PROMETHEUS_METRICS_TOKEN}' | base64 -d)
kubectl create secret generic demo-scrape-token -n demo-observability \
  --from-literal=token="$TOKEN"
kubectl rollout restart deployment/prometheus -n demo-observability
```

### Update dashboards after a pack release

```bash
kubectl create configmap grafana-dashboards -n demo-observability \
  --from-file=../../../../deploy/observability/dashboards/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/grafana -n demo-observability
```

### Image updates

Grafana and Prometheus are pinned in the manifests and public-facing — bump
them on the normal dependency cadence (Grafana CVEs are frequent).

## Notes

- **Prometheus has no ingress of its own**, but anonymous Grafana viewers can
  still run ad-hoc PromQL through Grafana's `/api/ds/query` proxy (disabling
  Explore only hides the UI). That surface is bounded three ways: the WAF
  per-IP rate limit on the demo-grafana host, Grafana's datasource
  `queryTimeout`, and Prometheus's `--query.timeout/max-samples/
  max-concurrency` flags.
- The demo tenant's NetworkPolicy (managed by the entitlement provisioner)
  carries matching demo-only rules: ingress 3001 from this namespace (scrape)
  and egress 9090 to it (OTLP push). The policies in `namespace.yaml` are this
  side of the same pair.
- OTLP-pushed series land under the job derived from the pushed
  `service.name` resource attribute; the scraped copy is job `betterdb`. The
  dashboards' "Scrape job" variable switches between the two paths.
- Rate limiting is NOT active until the WAF ingress annotation from install
  step 6 is applied — which is why publishing the token is step 7.
