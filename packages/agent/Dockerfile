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
# The build bundles @betterdb/shared (a private, unpublished workspace package)
# directly into dist/index.js via esbuild. That makes the output self-contained, so
# the production image below never has to vendor or resolve @betterdb/shared at
# runtime — the failure mode that made betterdb/agent:1.5.0/1.6.x crash-loop with
# "Cannot find module '@betterdb/shared'". shared's own dep, zod, is kept EXTERNAL
# (declared in the agent's dependencies) and installed in the production stage, so
# esbuild leaves it as a require() and it stays visible to vulnerability scanners.
FROM node:20-alpine AS agent-build
WORKDIR /build/agent

COPY packages/agent/package.json packages/agent/tsconfig.json ./
COPY packages/agent/scripts ./scripts

# Make shared resolvable as @betterdb/shared so esbuild can inline it. zod is
# external, so shared needs no node_modules of its own here — its `require('zod')`
# is left untouched in the bundle.
COPY --from=shared-build /build/shared/package.json /build/shared/package.json
COPY --from=shared-build /build/shared/dist /build/shared/dist

# Rewrite workspace:* to a file path so npm can resolve @betterdb/shared.
# devDependencies (esbuild, @betterdb/shared, typescript) are needed here for the
# type-check + bundle, so this install is NOT --omit=dev.
RUN sed -i 's|"workspace:\*"|"file:/build/shared"|' package.json \
    && npm install --ignore-scripts

COPY packages/agent/src ./src
RUN npm run build

# ---- Production image ----
FROM node:20-alpine
WORKDIR /app

# Install the declared runtime dependencies (AWS SDK, iovalkey, ws, zod);
# @betterdb/shared is bundled into dist/index.js, so it is not needed here. Remove
# the workspace-only @betterdb/shared devDependency (npm does not understand the
# `workspace:` protocol) with `npm pkg delete`, which edits package.json as JSON — a
# `sed` line-delete would corrupt the file if that entry were ever last in the block
# (trailing comma) and would substring-match a future @betterdb/shared-* too.
# --omit=dev drops esbuild and the other build-time devDependencies.
COPY packages/agent/package.json ./
RUN npm pkg delete devDependencies.@betterdb/shared \
    && npm install --omit=dev --ignore-scripts

# Bundled agent (shared inlined; runtime deps incl. zod installed above)
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
