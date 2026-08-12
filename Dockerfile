# Monitor/app version. Passed by CI (docker-publish.yml) as --build-arg APP_VERSION
# and applied to every stage that re-declares `ARG APP_VERSION`. Declared once here
# as a global ARG (before the first FROM) so the default lives in a single place.
ARG APP_VERSION=0.1.1

# ============================================
# Build Stage (shared by both image variants)
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

# Install dependencies (excluding entitlement workspace). Includes devDeps needed
# for the build; the no-ai variant strips them again in the cleanup stage below.
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
# RedisShake Build Stage (shared by both variants)
# ============================================
# Build the migration binary from source with a current Go toolchain so the
# embedded Go standard library is patched. The official prebuilt releases are
# compiled with Go 1.21.13 (EOL), whose stdlib carries dozens of CVEs (incl.
# criticals) that `apk upgrade` cannot fix - they are baked into the static
# binary, not provided by an Alpine package.
#
# --platform=$BUILDPLATFORM pins this stage to the native build host so `go build`
# cross-compiles (via GOARCH below) instead of running the toolchain under QEMU on
# the arm64 leg - QEMU is 5-10x slower and a known source of spurious SIGSEGV.
#
# The `go get golang.org/x/text@v0.39.0` step raises x/text to clear the Go CVE wall
# (v4.6.1's go.mod pins the vulnerable 0.14.0). Two caveats it introduces:
#   - It mutates go.mod/go.sum AFTER the commit tamper-check, so the shipped binary
#     is a v4.6.1 + x/text-0.39.0 combination upstream never released; an SBOM audit
#     against RedisShake v4.6.1 will show that single dependency delta.
#   - `go get pkg@exact-version` also DOWNGRADES. Once a future REDISSHAKE_VERSION's
#     go.mod already requires x/text >= 0.39.0, remove that line - otherwise it
#     silently pins x/text back down on the version bump.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS redisshake-builder
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
        go build -trimpath -ldflags "-s -w -X main.Version=v${REDISSHAKE_VERSION} -X main.GitCommit=${REDISSHAKE_COMMIT}" -o /out/redis-shake ./cmd/redis-shake

# ============================================
# Cleanup Stage - strip AI deps + devDeps (no-ai variant only)
# ============================================
FROM node:26-alpine AS cleanup

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Remove AI dependencies, devDependencies, and build tools (~150MB+ savings)
# AI packages are only needed when AI_ENABLED=true
# DevDependencies are only needed during build, not runtime
# Must remove from BOTH top-level symlinks AND .pnpm store (where pnpm keeps actual files)
RUN rm -rf \
    # AI-related top-level symlinks
    node_modules/@lancedb \
    node_modules/@langchain \
    node_modules/langchain \
    node_modules/hnswlib-node \
    node_modules/better-sqlite3 \
    node_modules/apache-arrow \
    node_modules/@apache-arrow \
    node_modules/ollama \
    node_modules/@huggingface \
    node_modules/openai \
    node_modules/js-tiktoken \
    apps/api/node_modules/@lancedb \
    apps/api/node_modules/@langchain \
    apps/api/node_modules/langchain \
    apps/api/node_modules/hnswlib-node \
    apps/api/node_modules/better-sqlite3 \
    apps/api/node_modules/apache-arrow \
    apps/api/node_modules/@apache-arrow \
    apps/api/node_modules/ollama \
    apps/api/node_modules/@huggingface \
    apps/api/node_modules/openai \
    apps/api/node_modules/js-tiktoken \
    # pnpm store - AI packages + devDependencies (actual files)
    && find node_modules/.pnpm -maxdepth 1 -type d \( \
        -name '@lancedb*' -o \
        -name '@langchain*' -o \
        -name 'langchain@*' -o \
        -name 'hnswlib-node@*' -o \
        -name 'better-sqlite3@*' -o \
        -name 'apache-arrow@*' -o \
        -name '@apache-arrow*' -o \
        -name 'ollama@*' -o \
        -name '@huggingface*' -o \
        -name 'vectordb@*' -o \
        -name '@napi-rs*' -o \
        -name 'openai@*' -o \
        -name 'js-tiktoken@*' -o \
        -name 'typescript@*' -o \
        -name 'turbo-*' -o \
        -name '@types+*' -o \
        -name 'prettier@*' -o \
        -name 'eslint@*' -o \
        -name '@typescript-eslint*' -o \
        -name 'jest@*' -o \
        -name 'ts-jest@*' -o \
        -name '@nestjs+cli@*' -o \
        -name '@nestjs+schematics@*' -o \
        -name '@nestjs+testing@*' -o \
        -name 'webpack@*' -o \
        -name '@esbuild*' -o \
        -name 'playwright*' \
    \) -exec rm -rf {} + 2>/dev/null || true

# Copy dist files and remove the AI module
COPY --from=builder /app/apps/api/dist ./apps/api/dist
RUN rm -rf /app/apps/api/dist/proprietary/ai

# ============================================
# Runtime Base - scaffolding shared by both production variants
# ============================================
# Everything that does not depend on the app payload lives here so the two terminal
# targets below differ only in which node_modules/dist they copy (builder vs cleanup)
# and a handful of env defaults.
FROM node:26-alpine AS runtime-base

# Apply the latest Alpine security patches and drop the npm CLI bundled in the base
# image. This image runs via `node` directly (deps are installed with pnpm at build
# time), so npm is unused at runtime and only contributes CVEs from its own vendored
# dependencies. No extra packages are installed: the healthcheck uses the busybox
# wget already in the base image, and busybox already provides tar - avoiding the
# full wget and GNU tar packages, both of which currently ship unfixable CVEs.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Create the non-root runtime user up front (Docker Scout compliance) so the
# COPY --chown instructions in the terminal stages can set ownership as files are
# written. This avoids a trailing `chown -R /app`, which would duplicate the entire
# ~550MB node_modules into a second layer just to change ownership bits.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs betterdb

# Install RedisShake binary for migration execution. Built from source in the
# redisshake-builder stage with a current Go toolchain so the embedded Go stdlib
# is patched (the upstream prebuilt release ships an EOL Go 1.21.13 runtime).
COPY --chmod=755 --from=redisshake-builder /out/redis-shake /usr/local/bin/redis-shake

# Set APP_VERSION from build argument (re-declares the global ARG for this stage)
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

# PostHog telemetry (backend, runtime)
ARG POSTHOG_API_KEY
ARG POSTHOG_HOST=https://eu.i.posthog.com
ENV POSTHOG_API_KEY=$POSTHOG_API_KEY
ENV POSTHOG_HOST=$POSTHOG_HOST

# Environment defaults common to both variants
ENV NODE_ENV=production
ENV PORT=3001
ENV STORAGE_TYPE=memory

# Expose port (can be overridden with -e PORT=<port> at runtime)
# Note: EXPOSE is documentation only - actual port binding happens via -p flag
EXPOSE 3001

# Health check - uses PORT (default 3001). Uses the busybox wget already in the base
# image (--spider exits 0 on HTTP 200, non-zero otherwise). Avoids both a full wget
# package and node's interpreter cold-start, which can exceed the timeout under the
# CPU pressure of a running migration.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -T 2 -q --spider "http://127.0.0.1:${PORT:-3001}/api/health" || exit 1

# Start the server
CMD ["node", "apps/api/dist/apps/api/src/main.js"]

# ------------------------------------------------------------------
# Shared payload copy is expressed twice (once per terminal target)
# because the node_modules/api-dist source differs (builder vs cleanup).
# Everything else is inherited from runtime-base.
# ------------------------------------------------------------------

# ============================================
# Production target: WITH AI features (the `<version>` / AI image)
# Build with: --target production (required - this is NOT the default stage)
# ============================================
FROM runtime-base AS production

# node_modules straight from builder (includes AI packages + native modules)
COPY --chown=betterdb:nodejs --from=builder /app/node_modules ./node_modules
COPY --chown=betterdb:nodejs --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Package files for module resolution
COPY --chown=betterdb:nodejs package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=betterdb:nodejs apps/api/package.json ./apps/api/
COPY --chown=betterdb:nodejs packages/shared/package.json ./packages/shared/

# Built backend (includes the AI proprietary module), frontend, and shared dist
COPY --chown=betterdb:nodejs --from=builder /app/apps/api/dist ./apps/api/dist
COPY --chown=betterdb:nodejs --from=builder /app/apps/web/dist ./apps/api/public
COPY --chown=betterdb:nodejs --from=builder /app/packages/shared/dist ./packages/shared/dist

# agent-memory dependency chain that api imports at runtime. valkey-search-kit has
# no production deps, so it needs no node_modules.
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

# Make /app writable by the runtime user so features that create new paths under
# it at runtime work - notably RedisShake's default relative `data` dir (it is
# spawned with cwd=/app) and sqlite/license files. This chowns only the /app
# directory node plus a pre-created data dir (non-recursive), so it does NOT
# duplicate node_modules the way `chown -R /app` did.
RUN mkdir -p /app/data && chown betterdb:nodejs /app /app/data

# Drop to the non-root user (created in runtime-base) for the runtime process.
USER betterdb

# ============================================
# Production target: WITHOUT AI features (the `latest` / no-ai image)
# Build with: --target production-no-ai, OR a bare `docker build` with no
# --target: this is the LAST stage, so it is Docker's default target. Keep it
# last - `latest` on Docker Hub tracks this no-ai image (see docker-publish.yml).
# ============================================
FROM runtime-base AS production-no-ai

# CLEANED node_modules from the cleanup stage (AI packages + devDeps stripped)
COPY --chown=betterdb:nodejs --from=cleanup /app/node_modules ./node_modules
COPY --chown=betterdb:nodejs --from=cleanup /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=betterdb:nodejs --from=cleanup /app/packages/shared/node_modules ./packages/shared/node_modules

# Package files for module resolution
COPY --chown=betterdb:nodejs package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=betterdb:nodejs apps/api/package.json ./apps/api/
COPY --chown=betterdb:nodejs packages/shared/package.json ./packages/shared/

# Built backend from cleanup (AI module already removed); frontend + shared dist
# come straight from builder (identical to the AI image).
COPY --chown=betterdb:nodejs --from=cleanup /app/apps/api/dist ./apps/api/dist
COPY --chown=betterdb:nodejs --from=builder /app/apps/web/dist ./apps/api/public
COPY --chown=betterdb:nodejs --from=builder /app/packages/shared/dist ./packages/shared/dist

# agent-memory dependency chain that api imports at runtime. valkey-search-kit has
# no dependencies so it carries no node_modules of its own.
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/package.json ./packages/agent-memory/
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/dist ./packages/agent-memory/dist
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-memory/node_modules ./packages/agent-memory/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/package.json ./packages/agent-cache/
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/dist ./packages/agent-cache/dist
COPY --chown=betterdb:nodejs --from=builder /app/packages/agent-cache/node_modules ./packages/agent-cache/node_modules
COPY --chown=betterdb:nodejs --from=builder /app/packages/valkey-search-kit/package.json ./packages/valkey-search-kit/
COPY --chown=betterdb:nodejs --from=builder /app/packages/valkey-search-kit/dist ./packages/valkey-search-kit/dist

# Create symlink for @proprietary path alias (ai module already excluded). Created
# as root (read-only at runtime); the app user only needs to read these symlinks.
RUN mkdir -p /app/node_modules/@proprietary && \
    for dir in /app/apps/api/dist/proprietary/*/; do \
        ln -s "$dir" /app/node_modules/@proprietary/; \
    done

# no-ai runtime env: database defaults, AI disabled, and NODE_PATH for workspace
# module resolution.
ENV DB_HOST=localhost
ENV DB_PORT=6379
ENV DB_TYPE=auto
ENV DB_USERNAME=default
ENV AI_ENABLED=false
ENV NODE_PATH=/app/node_modules

# Make /app writable by the runtime user (see the production target above).
RUN mkdir -p /app/data && chown betterdb:nodejs /app /app/data

# Drop to the non-root user (created in runtime-base) for the runtime process.
USER betterdb
