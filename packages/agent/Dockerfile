# Build context must be the monorepo root:
#   docker build -f packages/agent/Dockerfile -t betterdb-agent .
#
# Or from packages/agent/:
#   docker build -f Dockerfile -t betterdb-agent ../..

# ---- Build shared dependency ----
FROM node:20-alpine AS shared-build
WORKDIR /build/shared
COPY packages/shared/package.json packages/shared/tsconfig.json ./
COPY packages/shared/src ./src
RUN npm install --ignore-scripts && npm run build

# ---- Build agent ----
# The build bundles @betterdb/shared (a private, unpublished workspace package) and
# its only runtime dep (zod) directly into dist/index.js via esbuild. That makes the
# output self-contained, so the production image below installs ONLY the declared
# runtime dependencies and never has to vendor or resolve @betterdb/shared at
# runtime — the failure mode that made betterdb/agent:1.5.0/1.6.x crash-loop with
# "Cannot find module '@betterdb/shared'".
FROM node:20-alpine AS agent-build
WORKDIR /build/agent

COPY packages/agent/package.json packages/agent/tsconfig.json ./
COPY packages/agent/scripts ./scripts

# Make shared resolvable as @betterdb/shared so esbuild can inline it. esbuild
# resolves shared's own imports (zod) relative to shared's files, so zod must live
# under /build/shared/node_modules — installing it into the agent's node_modules is
# not enough (a sibling dir is not on shared's module-resolution path). Locally this
# is a non-issue because zod is hoisted to the monorepo root.
COPY --from=shared-build /build/shared/package.json /build/shared/package.json
COPY --from=shared-build /build/shared/dist /build/shared/dist
RUN cd /build/shared && npm install --omit=dev --ignore-scripts

# Rewrite workspace:* to a file path so npm can resolve @betterdb/shared.
# devDependencies (esbuild, @betterdb/shared) are needed here, so this install is
# NOT --omit=dev.
RUN sed -i 's|"workspace:\*"|"file:/build/shared"|' package.json \
    && npm install --ignore-scripts

COPY packages/agent/src ./src
RUN npm run build

# ---- Production image ----
FROM node:20-alpine
WORKDIR /app

# Only the declared runtime dependencies (AWS SDK, iovalkey, ws) are installed;
# @betterdb/shared + zod are already bundled into dist/index.js. Strip the
# workspace-only @betterdb/shared entry so npm (which does not understand the
# `workspace:` protocol) can install the rest. --omit=dev drops esbuild and the
# other build-time devDependencies.
COPY packages/agent/package.json ./
RUN sed -i '/@betterdb\/shared/d' package.json \
    && npm install --omit=dev --ignore-scripts

# Bundled agent (self-contained: shared + zod inlined)
COPY --from=agent-build /build/agent/dist ./dist

# Regression guard: run the real entrypoint at build time. If the bundle left any
# module unresolved — @betterdb/shared not inlined, or a runtime dep missing from
# the image — Node throws MODULE_NOT_FOUND and this fails the build instead of
# shipping an image that crash-loops. With no token the agent prints the token
# error and we assert on that, independent of its exit code.
RUN node dist/index.js 2>&1 | grep -q "BETTERDB_TOKEN" \
    || (echo "agent smoke test failed: entrypoint did not boot cleanly" && exit 1)

# Run as non-root
RUN addgroup -S agent && adduser -S agent -G agent
USER agent

CMD ["node", "dist/index.js"]
