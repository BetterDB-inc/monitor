# BetterDB Cloud — Entitlement Service

The entitlement service is BetterDB Cloud's control plane. It manages tenant lifecycle (CRUD, provisioning, deprovisioning), license generation, Stripe billing, and Kubernetes orchestration for multi-tenant deployments.

## Architecture

```
betterdb.com/signup → Vercel → API Gateway → VPC Link → NLB → Entitlement Service (EKS)
                                                                        │
                                                                        ├── RDS PostgreSQL (tenant metadata, Prisma)
                                                                        └── K8s API (provision/deprovision tenant namespaces)
```

The entitlement service runs in the `system` namespace on EKS and has RBAC permissions to create and manage tenant namespaces, deployments, services, ingresses, secrets, jobs, and resource quotas.

Each tenant gets:
- A dedicated K8s namespace (`tenant-{subdomain}`)
- A PostgreSQL schema (`tenant_{subdomain}`)
- A BetterDB Monitor deployment with health/readiness probes
- An ALB ingress routing `{subdomain}.app.betterdb.com` to the tenant pod
- Resource quotas (250m/256Mi requests, 500m/512Mi limits, 1 pod)

## Secrets Management

All sensitive values (database credentials, API keys, Stripe secrets) are managed via Kubernetes secrets and environment variables — never committed to the repository. Placeholders like `<RDS_PASSWORD>` and `<ADMIN_API_KEY>` appear throughout this document where real values are required.

## Prerequisites

- AWS CLI configured with appropriate credentials
- `kubectl` connected to the BetterDB EKS cluster
- Terraform initialized in `proprietary/infra/terraform/`
- Docker with multi-architecture build support
- pnpm 9.15.0+

## Project Structure

```
proprietary/
├── entitlement/
│   ├── Dockerfile              # Multi-stage build (node:20-slim)
│   ├── prisma/
│   │   └── schema.prisma       # Tenant, User, License models
│   ├── src/
│   │   ├── main.ts             # NestJS bootstrap (port 3002)
│   │   ├── tenant/             # Tenant CRUD (AdminGuard protected)
│   │   ├── provisioning/       # K8s provisioning pipeline
│   │   ├── admin/              # Customer & license management
│   │   ├── stripe/             # Stripe webhook handler
│   │   └── prisma/             # PrismaService
│   └── package.json
└── infra/
    ├── terraform/              # ECR, API Gateway, VPC Link
    └── k8s/
        ├── entitlement-rbac.yaml
        └── entitlement-deployment.yaml
```

## Deployment

### 1. Build and Push Docker Image

The Dockerfile uses `node:20-slim` (Debian) — not Alpine — to avoid OpenSSL/Prisma compatibility issues with musl.

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Get ECR URL
ECR_URL=$(cd proprietary/infra/terraform && terraform output -raw entitlement_ecr_url)

# Build from repo root (Dockerfile needs workspace context)
docker build -f proprietary/entitlement/Dockerfile -t ${ECR_URL}:<VERSION> .

# Push
docker push ${ECR_URL}:<VERSION>
```

### 2. Apply RBAC

The entitlement service needs cluster-wide permissions to manage tenant namespaces and resources.

```bash
kubectl apply -f proprietary/infra/k8s/entitlement-rbac.yaml
```

This creates:
- `ServiceAccount: entitlement` in the `system` namespace
- `ClusterRole: entitlement-provisioner` with permissions for namespaces, deployments, services, secrets, ingresses, jobs, resource quotas, and pod logs
- `ClusterRoleBinding` linking the two

### 3. Create Secrets and Deploy

```bash
# Create the secret (fill in real values)
kubectl create secret generic entitlement-config -n system \
  --from-literal=ADMIN_API_KEY=<your-admin-key> \
  --from-literal=RDS_HOST=<RDS_ENDPOINT> \
  --from-literal=RDS_USER=<RDS_USER> \
  --from-literal=RDS_PASSWORD=<RDS_PASSWORD> \
  --from-literal=RDS_DATABASE=<RDS_DATABASE> \
  --dry-run=client -o yaml | kubectl apply -f -

# Deploy
kubectl apply -f proprietary/infra/k8s/entitlement-deployment.yaml
```

### 4. Run Prisma Migrations

RDS is in a private subnet and not reachable from local machines. Run migrations from inside the pod:

```bash
kubectl exec -it -n system deploy/entitlement -- sh
cd /app/proprietary/entitlement
npx prisma migrate deploy
exit
```

The pod already has `ENTITLEMENT_DATABASE_URL` configured via the K8s secret.

**Baselining an existing database:** If the database already has tables (e.g., from manual setup during development), you'll see error `P3005: The database schema is not empty`. Fix by marking the initial migration as applied:

```bash
# Inside the pod
npx prisma migrate resolve --applied "20260211151131_init"
```

If you need to undo a baseline and re-run:

```bash
npx prisma db execute --stdin <<'SQL'
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260211151131_init';
SQL
npx prisma migrate deploy
```

### 5. Verify

```bash
# Check pod status
kubectl get pods -n system -l app=entitlement

# Check logs
kubectl logs -n system -l app=entitlement --tail=50

# Port-forward for local testing
kubectl port-forward -n system svc/entitlement 3002:3002

# Health check
curl http://localhost:3002/health

# Test tenant creation
curl -X POST http://localhost:3002/tenants \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test", "subdomain": "test99", "email": "test@example.com"}'
```

Expected response:
```json
{
  "id": "cmljostdp0000f2szpi8q26z3",
  "name": "Test",
  "subdomain": "test99",
  "email": "test@example.com",
  "status": "pending",
  "dbSchema": "tenant_test99",
  "imageTag": "v0.6.0",
  "createdAt": "2026-02-12T16:42:31.741Z",
  "updatedAt": "2026-02-12T16:42:31.741Z"
}
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check |
| `POST` | `/tenants` | AdminGuard | Create tenant |
| `GET` | `/tenants` | AdminGuard | List tenants |
| `GET` | `/tenants/:id` | AdminGuard | Get tenant by ID |
| `GET` | `/tenants/by-subdomain/:subdomain` | AdminGuard | Get tenant by subdomain |
| `PATCH` | `/tenants/:id` | AdminGuard | Update tenant |
| `DELETE` | `/tenants/:id` | AdminGuard | Delete tenant |
| `POST` | `/tenants/:id/provision` | AdminGuard | Trigger K8s provisioning |
| `POST` | `/tenants/:id/deprovision` | AdminGuard | Trigger K8s deprovisioning |
| `POST` | `/v1/entitlements` | — | License validation endpoint |
| `POST` | `/webhooks/stripe` | Stripe sig | Stripe webhook handler |
| `POST` | `/admin/customers` | AdminGuard | Create customer |
| `GET` | `/admin/customers` | AdminGuard | List customers |
| `GET` | `/admin/customers/:id` | AdminGuard | Get customer |
| `POST` | `/admin/licenses` | AdminGuard | Create license |
| `GET` | `/admin/licenses` | AdminGuard | List licenses |
| `GET` | `/admin/licenses/:id` | AdminGuard | Get license |
| `PUT` | `/admin/licenses/:id` | AdminGuard | Update license |
| `DELETE` | `/admin/licenses/:id` | AdminGuard | Delete license |
| `GET` | `/admin/licenses/:id/stats` | AdminGuard | License usage stats |

## Tenant Lifecycle

```
POST /tenants        →  status: pending
POST /tenants/:id/provision  →  status: provisioning → ready (or error)
POST /tenants/:id/deprovision  →  status: deleting → (record deleted)
```

Provisioning creates: namespace → secret → schema (via K8s Job running psql) → resource quota → deployment → service → ingress → waits for pod readiness.

Deprovisioning reverses: drop schema (via K8s Job) → delete namespace (cascades all K8s resources) → hard delete tenant record.

## Troubleshooting

**`libssl.so.1.1: No such file or directory`** — The Dockerfile must use `node:20-slim` (Debian) with `apt-get install -y openssl`, not Alpine. Prisma's query engine requires OpenSSL and has compatibility issues with Alpine's musl libc.

**`P1001: Can't reach database server`** — RDS is in a private subnet. Run Prisma commands from inside the pod, not locally.

**`P3005: The database schema is not empty`** — The database has existing tables. Baseline the migration with `prisma migrate resolve --applied`.

**`ImagePullBackOff`** — ECR authentication may have expired. Re-run `aws ecr get-login-password` or check the image tag exists in ECR.

**`CrashLoopBackOff`** — Check pod logs with `kubectl logs`. Common causes: missing env vars, RDS connection issues, or TLS certificate rejection.
