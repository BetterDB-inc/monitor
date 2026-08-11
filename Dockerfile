# Monitor/app version. Passed by CI (docker-publish.yml) as --build-arg APP_VERSION
# and applied to every stage that re-declares `ARG APP_VERSION`. Declared once here
# as a global ARG (before the first FROM) so the default lives in a single place.
ARG APP_VERSION=0.1.1

# ============================================
# Build Stage
# ============================================
FROM node:26-alpine AS builder

# Install build dependencies for native modules (hnswlib-node) and npm (for corepack)
RUN apk add --no-cache python3 make g++ npm

# Install pnpm via corepack (use --force to handle yarn symlink conflict)
RUN npm install -g --force corepack && corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
# api depends on @betterdb/agent-memory (MCP memory + memory proposals), which in
# turn pulls @betterdb/agent-cache and @betterdb/valkey-search-kit. They must be
# present for the workspace install + build to resolve.
COPY packages/agent-memory/package.json ./packages/agent-memory/
COPY packages/agent-cache/package.json ./packages/agent-cache/
COPY packages/valkey-search-kit/package.json ./packages/valkey-search-kit/

# Install dependencies (excluding entitlement workspace)
RUN pnpm install --frozen-lockfile --filter '!@app/entitlement'

# Copy source code (excluding entitlement app)
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/agent-memory ./packages/agent-memory
COPY packages/agent-cache ./packages/agent-cache
COPY packages/valkey-search-kit ./packages/valkey-search-kit
COPY proprietary ./proprietary

# Create symlink for proprietary node_modules (symlinks don't copy properly)
RUN ln -sf ../apps/api/node_modules proprietary/node_modules

# PostHog telemetry token (baked into frontend at build time)
ARG VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
ARG VITE_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
ENV VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=$VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
ENV VITE_PUBLIC_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST

# Monitor version (baked into the frontend so PostHog events carry the release).
# Re-declares the global ARG to bring it into this stage, then exposes it to Vite
# via the VITE_PUBLIC_ prefix so it reaches import.meta.env in the web build.
ARG APP_VERSION
ENV VITE_PUBLIC_APP_VERSION=$APP_VERSION

# Registration proxy URL (baked into frontend at build time).
# Defaults to the canonical www host so the in-app registration form on
# self-hosted instances reaches the public website proxy out of the box.
ARG VITE_REGISTRATION_URL=https://www.betterdb.com/api/register
ENV VITE_REGISTRATION_URL=$VITE_REGISTRATION_URL

# Build api, web, and their dependency graphs (exclude entitlement). The "..."
# suffix pulls in @betterdb/shared plus the agent-memory dependency chain.
RUN pnpm --filter "api..." --filter "web..." build

# ============================================
# RedisShake Build Stage
# ============================================
# Build the migration binary from source with a current Go toolchain so the
# embedded Go standard library is patched. The official prebuilt releases are
# compiled with Go 1.21.13 (EOL), whose stdlib carries dozens of CVEs (incl.
# criticals) that `apk upgrade` cannot fix - they are baked into the static
# binary, not provided by an Alpine package.
FROM golang:1.26-alpine AS redisshake-builder
ARG TARGETARCH
ARG REDISSHAKE_VERSION=4.6.1
# v4.6.1 is a lightweight tag -> pin its exact release commit for tamper-evidence.
ARG REDISSHAKE_COMMIT=a2a7e4e46d15708b6ab203e1c10a108aa405a638
RUN apk add --no-cache git
WORKDIR /build
RUN git clone --depth 1 --branch "v${REDISSHAKE_VERSION}" https://github.com/tair-opensource/RedisShake.git . && \
    test "$(git rev-parse HEAD)" = "${REDISSHAKE_COMMIT}" && \
    go get golang.org/x/text@v0.39.0 && \
    CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
        go build -trimpath -ldflags "-s -w" -o /out/redis-shake ./cmd/redis-shake

# ============================================
# Production Stage
# ============================================
FROM node:26-alpine AS production

# Apply the latest Alpine security patches and drop the npm CLI bundled in the base
# image. This image runs via `node` directly (deps are installed with pnpm at build
# time), so npm is unused at runtime and only contributes CVEs from its own vendored
# dependencies. No extra packages are installed: the healthcheck uses `node` (below)
# instead of wget, and busybox already provides tar - avoiding the full wget and GNU
# tar packages, both of which currently ship unfixable CVEs.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Create the non-root runtime user up front (Docker Scout compliance) so the
# COPY --chown instructions below can set ownership as files are written. This
# avoids a trailing `chown -R /app`, which would duplicate the entire ~550MB
# node_modules into a second layer just to change ownership bits.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs betterdb

# Set APP_VERSION from build argument (re-declares the global ARG for this stage)
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

# Copy pre-built node_modules from builder (includes native modules already compiled)
COPY --chown=betterdb:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=betterdb:nodejs --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Copy package files for module resolution
COPY --chown=betterdb:nodejs package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=betterdb:nodejs apps/api/package.json ./apps/api/
COPY --chown=betterdb:nodejs packages/shared/package.json ./packages/shared/

# Copy built backend
COPY --chown=betterdb:nodejs --from=builder /app/apps/api/dist ./apps/api/dist

# Copy built frontend to be served by backend
COPY --chown=betterdb:nodejs --from=builder /app/apps/web/dist ./apps/api/public

# Copy shared package dist
COPY --chown=betterdb:nodejs --from=builder /app/packages/shared/dist ./packages/shared/dist

# Copy the agent-memory dependency chain that api imports at runtime. valkey-search-kit
# has no production deps, so it needs no node_modules.
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/package.json ./packages/agent-memory/
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/dist ./packages/agent-memory/dist
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/node_modules ./packages/agent-memory/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/package.json ./packages/agent-cache/
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/dist ./packages/agent-cache/dist
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/node_modules ./packages/agent-cache/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/valkey-search-kit/package.json ./packages/valkey-search-kit/
COPY --chown=betterdb:nodejs --from=builder /app/packages/valkey-search-kit/dist ./packages/valkey-search-kit/dist

# Create symlink for @proprietary path alias to work at runtime. Created as root
# (read-only at runtime); the app user only needs to traverse/read these symlinks.
RUN mkdir -p /app/node_modules/@proprietary && \
    ln -s /app/apps/api/dist/proprietary/* /app/node_modules/@proprietary/

# PostHog telemetry (backend, runtime)
ARG POSTHOG_API_KEY
ARG POSTHOG_HOST=https://eu.i.posthog.com
ENV POSTHOG_API_KEY=$POSTHOG_API_KEY
ENV POSTHOG_HOST=$POSTHOG_HOST

# Set environment defaults (only non-database config)
ENV NODE_ENV=production
ENV PORT=3001
ENV STORAGE_TYPE=memory

# Install RedisShake binary for migration execution. Built from source in the
# redisshake-builder stage with a current Go toolchain so the embedded Go stdlib
# is patched (the upstream prebuilt release ships an EOL Go 1.21.13 runtime).
COPY --from=redisshake-builder /out/redis-shake /usr/local/bin/redis-shake
RUN chmod +x /usr/local/bin/redis-shake

# Drop to the non-root user (created above) for the runtime process.
USER betterdb

# Expose port (can be overridden with -e PORT=<port> at runtime)
# Note: EXPOSE is documentation only - actual port binding happens via -p flag
EXPOSE 3001

# Health check - uses PORT environment variable. Uses node (always present) rather
# than wget so the image needs no extra wget package.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Start the server
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
