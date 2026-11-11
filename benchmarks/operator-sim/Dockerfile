# In-cluster harness image: warm, app-gen, ground-truth collector, smoke tests.
# GLIDE ships a glibc native addon, so no alpine.
FROM node:22-slim
WORKDIR /sim
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY config ./config
COPY src ./src
ENTRYPOINT ["pnpm", "exec", "tsx", "src/incluster.ts"]
