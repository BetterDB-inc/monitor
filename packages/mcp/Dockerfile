FROM node:20-alpine AS build
WORKDIR /app

# Copy only what's needed — no monorepo context required
COPY package.json tsconfig.json ./
COPY src ./src

RUN npm install --ignore-scripts && npm run build

# ---- Production image ----
FROM node:20-alpine
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

RUN npm install --omit=dev --ignore-scripts

# Run as non-root
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

CMD ["node", "dist/index.js"]
