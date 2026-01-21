# ============================================
# Build Stage
# ============================================
FROM node:20-alpine AS builder

# Install build dependencies for native modules (hnswlib-node)
RUN apk add --no-cache python3 make g++

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

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
FROM node:20-alpine AS production

# Only wget needed for healthcheck - no build tools!
RUN apk add --no-cache wget

WORKDIR /app

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

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_HOST=localhost
ENV DB_PORT=6379
ENV DB_TYPE=auto
ENV DB_USERNAME=default
ENV STORAGE_TYPE=memory

# Expose port (can be overridden with -e PORT=<port> at runtime)
# Note: EXPOSE is documentation only - actual port binding happens via -p flag
EXPOSE 3001

# Health check - uses PORT environment variable
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/api/health || exit 1

# Start the server
CMD ["node", "apps/api/dist/apps/api/src/main.js"]
