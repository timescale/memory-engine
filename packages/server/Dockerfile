# =============================================================================
# Stage 1 — build the web UI (Vite). Kept separate so the runtime image carries
# only the built static assets, not the web build toolchain (vite/react/...).
# =============================================================================
FROM oven/bun:1.3.13 AS web-builder

WORKDIR /app

# Every workspace package.json + lockfile, so the workspace tree matches
# bun.lock for --frozen-lockfile (same rationale as the runtime stage below).
COPY package.json bun.lock ./
COPY packages/auth/package.json packages/auth/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/database/package.json packages/database/
COPY packages/docs-site/package.json packages/docs-site/
COPY packages/embedding/package.json packages/embedding/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY scripts/package.json scripts/
COPY e2e/package.json e2e/

# Install the web package + its transitive workspace deps, WITH devDependencies
# (Vite and friends), so we can build the UI.
RUN bun install --filter @memory.build/web --frozen-lockfile --ignore-scripts

# Web source + the workspace packages it bundles from source (client → protocol).
COPY packages/web/ packages/web/
COPY packages/client/ packages/client/
COPY packages/protocol/ packages/protocol/

# Produces packages/web/dist (the server serves this at WEB_DIST).
RUN bun run --cwd packages/web build

# =============================================================================
# Stage 2 — runtime: the server + the built web UI.
# =============================================================================
FROM oven/bun:1.3.13

WORKDIR /app
CMD ["bun", "run", "packages/server/index.ts"]
EXPOSE 3000

# Copy every workspace package.json so the workspace tree matches bun.lock.
# bun install --frozen-lockfile fails with "lockfile had changes" if any
# workspace declared in bun.lock is missing from the build context, so any
# new workspace added under packages/* must be copied here too.
COPY package.json bun.lock ./
COPY packages/auth/package.json packages/auth/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/database/package.json packages/database/
COPY packages/docs-site/package.json packages/docs-site/
COPY packages/embedding/package.json packages/embedding/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
COPY scripts/package.json scripts/
COPY e2e/package.json e2e/

# --filter limits installation to the server and its transitive workspace deps,
# avoiding pulling in docs-site's heavy runtime deps (next/react/tailwind/...).
RUN bun install --filter memory-engine-server --frozen-lockfile --production --ignore-scripts

ENV NODE_ENV=production

# Copy root version module (imported by server)
COPY version.ts ./

# Copy server source + all workspace dependencies
COPY packages/server/ packages/server/
COPY packages/auth/ packages/auth/
COPY packages/database/ packages/database/
COPY packages/engine/ packages/engine/
COPY packages/embedding/ packages/embedding/
COPY packages/protocol/ packages/protocol/
COPY packages/worker/ packages/worker/

# The built web UI (served at WEB_DIST, default packages/web/dist).
COPY --from=web-builder /app/packages/web/dist packages/web/dist
