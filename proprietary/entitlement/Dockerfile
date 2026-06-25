# ============================================
# Build Stage
# ============================================
FROM node:20-slim AS builder

# Install build dependencies (apt-get, not apk)
RUN apt-get update && apt-get install -y python3 make g++ openssl && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace root files for pnpm workspace resolution
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json files for dependency resolution
COPY packages/shared/package.json ./packages/shared/
COPY proprietary/entitlement/package.json ./proprietary/entitlement/

# Install all dependencies (including devDeps for build)
RUN pnpm install --frozen-lockfile

# Copy shared package source and build it
COPY packages/shared/ ./packages/shared/
RUN pnpm --filter @betterdb/shared build

# Copy entitlement source
COPY proprietary/entitlement/ ./proprietary/entitlement/

# Generate Prisma client
RUN cd proprietary/entitlement && pnpm prisma:generate

# Build entitlement service
RUN cd proprietary/entitlement && pnpm build

# ============================================
# Production Stage
# ============================================
FROM node:20-slim

# Install runtime dependencies (openssl for Prisma, wget for healthcheck/helm)
RUN apt-get update && apt-get install -y openssl wget && rm -rf /var/lib/apt/lists/*

# Install helm — the provisioner shells out to `helm template` to render the
# charts/valkey-search chart before applying it with the k8s SDK.
ARG HELM_VERSION=v3.16.3
RUN wget -qO /tmp/helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
  && tar -xzf /tmp/helm.tar.gz -C /tmp \
  && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
  && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

WORKDIR /app

# Copy everything we need from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/proprietary/entitlement/node_modules ./proprietary/entitlement/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/proprietary/entitlement/dist ./proprietary/entitlement/dist
COPY --from=builder /app/proprietary/entitlement/prisma ./proprietary/entitlement/prisma
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/package.json ./package.json

# Bundle the valkey-search chart the provisioner renders (VALKEY_CHART_PATH).
COPY charts/valkey-search ./charts/valkey-search

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3002/health || exit 1

USER node
CMD ["node", "proprietary/entitlement/dist/main.js"]