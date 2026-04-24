FROM oven/bun:1.3.13

WORKDIR /app
CMD ["bun", "run", "packages/server/index.ts"]
EXPOSE 3000

# Copy all workspace package.json files so bun.lock is valid
COPY package.json bun.lock ./
COPY packages/accounts/package.json packages/accounts/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/embedding/package.json packages/embedding/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY scripts/package.json scripts/

RUN bun install --frozen-lockfile --production --ignore-scripts

ENV NODE_ENV=production

# Copy root version module (imported by server)
COPY version.ts ./

# Copy server source + all workspace dependencies
COPY packages/server/ packages/server/
COPY packages/accounts/ packages/accounts/
COPY packages/client/ packages/client/
COPY packages/engine/ packages/engine/
COPY packages/embedding/ packages/embedding/
COPY packages/protocol/ packages/protocol/
COPY packages/worker/ packages/worker/
