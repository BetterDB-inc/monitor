FROM node:26-alpine AS build
WORKDIR /app

# Copy only what's needed — no monorepo context required
COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install --ignore-scripts && npm run build

# ---- Production image ----
FROM node:26-alpine

# Apply the latest Alpine security patches (the base image lags behind fixed
# openssl/zlib/busybox releases).
RUN apk upgrade --no-cache

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

# The image runs via `node` directly, so drop the npm CLI bundled in the base image
# once dependencies are installed - it only contributes CVEs from its own vendored
# dependencies.
RUN npm install --omit=dev --ignore-scripts \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Run as non-root
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

CMD ["node", "dist/index.js"]
