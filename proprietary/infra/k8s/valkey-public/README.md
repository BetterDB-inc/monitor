# Public Valkey exposure — shared infra

This directory stands up the **one-time, cluster-level** infrastructure that lets
tenants reach their Valkey + search instances over a public TLS endpoint at
`<instance>.valkey.betterdb.com`.

Per-instance resources (Secret, StatefulSet, Service, `IngressRouteTCP`) are NOT
here — those are rendered from `charts/valkey-search` and applied by the
entitlement provisioner when a user creates an instance. This directory only
provides the shared plumbing those routes plug into.

## Architecture

```
client (valkey-cli --tls, SNI=acme.valkey.betterdb.com)
        │  TLS over TCP/6379
        ▼
   AWS NLB (internet-facing)          ← created by the Traefik Service
        │
        ▼
   Traefik  (entrypoint: valkey-tls)
        │  - terminates TLS with the *.valkey.betterdb.com wildcard cert
        │  - reads SNI from the ClientHello
        │  - matches IngressRouteTCP HostSNI(`acme.valkey.betterdb.com`)
        ▼
   tenant Service (ClusterIP :6379)  ← in namespace tenant-acme
        ▼
   Valkey StatefulSet (ACL: default off, app user, FT.* enabled)
```

- One NLB and one wildcard cert serve **all** instances; adding a tenant is just
  another `IngressRouteTCP` (no new LB, no new cert, no new DNS record).
- DNS is a single wildcard `*.valkey.betterdb.com` → the NLB. The provisioner
  does **not** create per-instance Route53 records.

## Prerequisites

- EKS cluster with the AWS Load Balancer Controller installed (already used for
  the Monitor ALB ingress).
- A Route53 hosted zone for `valkey.betterdb.com` (delegate it from the parent
  `betterdb.com` zone, or create records there directly).
- `helm` and `kubectl` pointed at the cluster.

## Install

### 1. cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true
```

Give cert-manager Route53 access via IRSA so the DNS-01 solver can write TXT
records. Create an IAM role trusted by the cert-manager controller
ServiceAccount with this policy (scope the Resource to the
`valkey.betterdb.com` hosted zone where possible):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "route53:GetChange", "Resource": "arn:aws:route53:::change/*" },
    { "Effect": "Allow", "Action": ["route53:ChangeResourceRecordSets","route53:ListResourceRecordSets"], "Resource": "arn:aws:route53:::hostedzone/*" },
    { "Effect": "Allow", "Action": "route53:ListHostedZonesByName", "Resource": "*" }
  ]
}
```

Then annotate the SA and restart the controller:

```bash
kubectl annotate sa cert-manager -n cert-manager \
  eks.amazonaws.com/role-arn=arn:aws:iam::811740411689:role/betterdb-cert-manager --overwrite
kubectl rollout restart deploy/cert-manager -n cert-manager
```

### 2. ClusterIssuer

```bash
kubectl apply -f clusterissuer.yaml
```

### 3. Traefik (creates the NLB)

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm upgrade --install traefik traefik/traefik \
  -n traefik --create-namespace -f traefik-values.yaml
```

### 4. Wildcard DNS

Wait for the NLB hostname, then point the wildcard at it:

```bash
kubectl get svc traefik -n traefik \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Create a Route53 record in the `valkey.betterdb.com` zone:

- Name: `*.valkey.betterdb.com`
- Type: `CNAME` (or an A/ALIAS to the NLB)
- Value: the NLB hostname from above

### 5. Wildcard certificate + default TLS store

```bash
kubectl apply -f wildcard-certificate.yaml
```

cert-manager will solve the DNS-01 challenge and populate the
`valkey-wildcard-tls` Secret in the `traefik` namespace.

## Verify

```bash
# Certificate issued?
kubectl get certificate valkey-wildcard -n traefik
# READY should be True

# Traefik is serving the wildcard on the NLB (after a tenant instance exists):
openssl s_client -connect acme.valkey.betterdb.com:6379 \
  -servername acme.valkey.betterdb.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
# subject=CN=*.valkey.betterdb.com

# End-to-end as the tenant app user:
valkey-cli --tls -h acme.valkey.betterdb.com -p 6379 \
  --user <username> --pass <password> ping
```

## How per-instance routing is wired

When a user provisions an instance, the entitlement provisioner renders
`charts/valkey-search` with `exposure.public=true`,
`exposure.host=<instance>.valkey.betterdb.com`, and
`exposure.sniRoute.enabled=true`. That produces an `IngressRouteTCP` in the
tenant namespace:

```yaml
spec:
  entryPoints: [valkey-tls]
  routes:
    - match: HostSNI(`acme.valkey.betterdb.com`)
      services:
        - { name: <release>-valkey-search, port: 6379 }
  tls:
    passthrough: false   # Traefik terminates with the default (wildcard) cert
```

Because `allowCrossNamespace: true` is set, Traefik (in `traefik`) watches these
routes in the tenant namespaces and serves them on the shared `valkey-tls`
entrypoint.
