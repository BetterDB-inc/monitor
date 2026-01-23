# ============================================
# Build Stage
# ============================================
FROM node:25-alpine AS builder

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

# Install dependencies (excluding entitlement workspace)
RUN pnpm install --frozen-lockfile --filter '!@app/entitlement'

# Copy source code (excluding entitlement app)
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY proprietary ./proprietary

# Create symlink for proprietary node_modules (symlinks don't copy properly)
RUN ln -sf ../apps/api/node_modules proprietary/node_modules

# Build only api, web, and shared (exclude entitlement)
RUN pnpm --filter api --filter web --filter @betterdb/shared build

# ============================================
# Production Stage
# ============================================
FROM node:25-alpine AS production

# Install wget for healthcheck and tar (>=7.5.4) for security fix
# Upgrade all packages to get latest security patches (including Go stdlib in binaries)
RUN apk add --no-cache wget tar>=7.5.4 && \
    apk upgrade --no-cache

WORKDIR /app

# Set APP_VERSION from build argument
ARG APP_VERSION=0.1.1
ENV APP_VERSION=$APP_VERSION

# Copy pre-built node_modules from builder (includes native modules already compiled)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules

# Copy package files for module resolution
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Copy built backend
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Copy built frontend to be served by backend
COPY --from=builder /app/apps/web/dist ./apps/api/public

# Copy shared package dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Create symlink for @proprietary path alias to work at runtime
RUN mkdir -p /app/node_modules/@proprietary && \
    ln -s /app/apps/api/dist/proprietary/* /app/node_modules/@proprietary/

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_HOST=localhost
ENV DB_PORT=6379
ENV DB_TYPE=auto
ENV DB_USERNAME=default
ENV STORAGE_TYPE=memory

# Create non-root user for security (Docker Scout compliance)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs betterdb

# Change ownership of app directory
RUN chown -R betterdb:nodejs /app

USER betterdb

# Expose port (can be overridden with -e PORT=<port> at runtime)
# Note: EXPOSE is documentation only - actual port binding happens via -p flag
EXPOSE 3001

# Health check - uses PORT environment variable
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Start the server
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
