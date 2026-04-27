FROM oven/bun:1.3.13

WORKDIR /app
CMD ["bun", "run", "packages/server/index.ts"]
EXPOSE 3000

# Copy every workspace package.json so the workspace tree matches bun.lock.
# bun install --frozen-lockfile fails with "lockfile had changes" if any
# workspace declared in bun.lock is missing from the build context, so any
# new workspace added under packages/* must be copied here too.
COPY package.json bun.lock ./
COPY packages/accounts/package.json packages/accounts/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/docs-site/package.json packages/docs-site/
COPY packages/embedding/package.json packages/embedding/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY scripts/package.json scripts/

# --filter limits installation to the server and its transitive workspace deps,
# avoiding pulling in docs-site's heavy runtime deps (next/react/tailwind/...).
RUN bun install --filter memory-engine-server --frozen-lockfile --production --ignore-scripts

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
