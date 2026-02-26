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

# Shared package
COPY --from=shared-build /build/shared/package.json /opt/shared/package.json
COPY --from=shared-build /build/shared/dist /opt/shared/dist

# Agent package.json with rewritten dep + production install
COPY packages/agent/package.json ./
RUN sed -i 's|"workspace:\*"|"file:/opt/shared"|' package.json \
    && npm install --omit=dev --ignore-scripts

# Compiled agent code
COPY --from=agent-build /build/agent/dist ./dist

# Run as non-root
RUN addgroup -S agent && adduser -S agent -G agent
USER agent

CMD ["node", "dist/index.js"]
