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
FROM node:20-alpine AS agent-build
WORKDIR /build/agent

COPY packages/agent/package.json packages/agent/tsconfig.json ./

# Make shared available as a file dependency
COPY --from=shared-build /build/shared/package.json /build/shared/package.json
COPY --from=shared-build /build/shared/dist /build/shared/dist

# Rewrite workspace:* to file path so npm can resolve it
RUN sed -i 's|"workspace:\*"|"file:/build/shared"|' package.json \
    && npm install --ignore-scripts

COPY packages/agent/src ./src
RUN npx tsc

# ---- Production image ----
FROM node:20-alpine
WORKDIR /app

# Shared workspace package, vendored INSIDE /app (not /opt) on purpose. npm
# symlinks a file: dependency and Node resolves that symlink to its realpath before
# looking up the package's own runtime deps (e.g. zod). If shared lives outside
# /app, that lookup walks /opt/... and never reaches /app/node_modules, so the image
# crash-loops with "Cannot find module 'zod'". Vendored under /app, upward
# resolution from shared's files reaches /app/node_modules where zod is installed.
COPY --from=shared-build /build/shared/package.json ./vendor/shared/package.json
COPY --from=shared-build /build/shared/dist ./vendor/shared/dist

# Agent package.json with rewritten dep + production install.
# @betterdb/shared MUST be a runtime `dependency` (not devDependency): it is
# imported at runtime (extractPattern, checkBlocked, pruneKeyDetails, protocol
# types) and `--omit=dev` drops devDependencies, so a devDependency here ships an
# image that crash-loops with "Cannot find module '@betterdb/shared'". The file:
# reference also pulls shared's own runtime deps (zod) into node_modules. It stays
# out of the published npm package via the release workflow's "Prepare for
# publishing" step, which strips it before `npm publish`.
COPY packages/agent/package.json ./
RUN sed -i 's|"workspace:\*"|"file:./vendor/shared"|' package.json \
    && npm install --omit=dev --ignore-scripts

# Compiled agent code
COPY --from=agent-build /build/agent/dist ./dist

# Regression guard: fail the build (not the user's container at runtime) if the
# shared package or its runtime deps are not resolvable — catches @betterdb/shared
# slipping back into devDependencies, or shared being vendored where Node cannot
# resolve zod, before the image is ever published.
RUN node -e "require('@betterdb/shared')"

# Run as non-root
RUN addgroup -S agent && adduser -S agent -G agent
USER agent

CMD ["node", "dist/index.js"]
