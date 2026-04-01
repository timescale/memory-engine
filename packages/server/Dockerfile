FROM oven/bun:1.3.11

WORKDIR /app
CMD ["bun", "run", "packages/server/index.ts"]
EXPOSE 3000

# Reproduce workspace structure so bun.lock is valid
COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/embedding/package.json packages/embedding/
COPY packages/engine/package.json packages/engine/
COPY packages/worker/package.json packages/worker/
COPY scripts/package.json scripts/
RUN bun install --frozen-lockfile --production --ignore-scripts

ENV NODE_ENV=production

COPY packages/server/tsconfig.json packages/server/index.ts packages/server/
