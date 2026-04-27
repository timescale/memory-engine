# Development

## Prerequisites

- [Bun](https://bun.sh) (latest)
- [Docker](https://www.docker.com/) (for PostgreSQL)

## Quick Start

```bash
bun install
bun run pg
# configure .env (see below)
bun run setup
bun run server
# in another terminal:
bun run packages/cli/index.ts --server http://localhost:3000 login
```

## Step by Step

### 1. Install dependencies

```bash
bun install
```

### 2. Start PostgreSQL

The project requires PostgreSQL 18 with three extensions: `pgvector`, `pg_textsearch`, and `ltree`. The included Dockerfile builds a pre-configured image:

```bash
bun run pg
```

This builds the Docker image and starts a container named `me-postgres` on `localhost:5432` with trust authentication (no password).

Other database commands:

| Command | Description |
|---|---|
| `bun run pg:rm` | Stop and remove the container |
| `bun run psql` | Connect with psql |

### 3. Configure `.env`

Copy the sample and fill in the required values:

```bash
cp .env.sample .env
```

#### Required variables

**Database connections** — both point to the local Docker Postgres, but use separate databases:

```
ACCOUNTS_DATABASE_URL=postgres://postgres@localhost:5432/accounts
ENGINE_DATABASE_URL=postgres://postgres@localhost:5432/shard1
```

**Encryption master key** — 32-byte hex string for encrypting API keys at rest:

```bash
bun run generate:master-key
```

Paste the output into `.env`:

```
ACCOUNTS_MASTER_KEY=<output from above>
```

**Server URL and port** — `API_BASE_URL` is used to construct OAuth callback URLs. `PORT` controls which port the server listens on. They must be consistent:

```
API_BASE_URL=http://localhost:3000
PORT=3000
```

If you change the port (e.g. because something else is on 3000), update both:

```
API_BASE_URL=http://localhost:3132
PORT=3132
```

**Embedding API key** — an OpenAI API key (or compatible provider):

```
EMBEDDING_API_KEY=sk-...
```

#### OAuth provider (at least one required)

**Google:**

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth client ID (Web application)
3. Add authorized redirect URI: `http://localhost:<PORT>/api/v1/auth/callback/google`
4. Copy the client ID and secret:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

**GitHub:**

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Create a new OAuth App
3. Set the callback URL to: `http://localhost:<PORT>/api/v1/auth/callback/github`
4. Copy the client ID and secret:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

> The redirect URI must match your `API_BASE_URL` exactly, including the port.

#### Complete `.env` example

```bash
# Database
ACCOUNTS_DATABASE_URL=postgres://postgres@localhost:5432/accounts
ENGINE_DATABASE_URL=postgres://postgres@localhost:5432/shard1
ACCOUNTS_MASTER_KEY=<bun run generate:master-key>

# Server
API_BASE_URL=http://localhost:3000
PORT=3000

# Embedding
EMBEDDING_API_KEY=sk-...

# OAuth (at least one)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Telemetry (optional) — omit to disable
# LOGFIRE_TOKEN=...
# LOGFIRE_ENVIRONMENT=dev
```

### 4. Run setup

```bash
bun run setup
```

This is idempotent (safe to run multiple times) and will:

1. Create the `accounts` and `shard1` databases if they don't exist
2. Run account schema migrations
3. Create and activate an encryption data key
4. Bootstrap the engine database (extensions and roles)

### 5. Start the server

```bash
bun run server
```

### 6. Test with the CLI

In another terminal:

```bash
bun run packages/cli/index.ts --server http://localhost:3000 login
```

Or set `ME_SERVER` to avoid passing `--server` every time:

```bash
export ME_SERVER=http://localhost:3000
bun run packages/cli/index.ts login
```

After login, the server URL is stored as the default in `~/.config/me/credentials.yaml`, so subsequent commands don't need `--server`.

## All Commands

| Command | Description |
|---|---|
| `bun run server` | Start the server |
| `bun run setup` | Create databases, run migrations, bootstrap engine |
| `bun run pg` | Build and start PostgreSQL in Docker |
| `bun run pg:rm` | Stop and remove the PostgreSQL container |
| `bun run psql` | Connect to PostgreSQL with psql |
| `bun run test` | Run tests |
| `bun run check` | Format + lint + typecheck |
| `bun run build` | Compile CLI binary (current platform) |
| `bun run build:all` | Cross-compile CLI for all platforms |
| `bun run install:local` | Build and install local CLI binary to your PATH |
| `bun run clean` | Remove build artifacts |
| `bun run generate:master-key` | Generate a new encryption master key |
| `bun run release:client` | Cut a client release (CLI + npm packages) |
| `bun run release:server` | Cut a server release (deploys to prod) |

## Releases

The client (CLI, npm packages) and the server (deployed container) are
released independently. They carry separate version counters, use separate
tag prefixes, and are triggered by separate scripts.

### Two versions

| Constant | Source of truth | Exposed via |
|---|---|---|
| `CLIENT_VERSION` | root `package.json` | `me --version`, MCP handshake, npm-published packages |
| `SERVER_VERSION` | `packages/server/package.json` | Logfire `serviceVersion`, migration `applied_at_version` and `<schema>.version`, gitRevision fallback in prod |

Both are exported from `version.ts`. Migration tracking — including the
downgrade-rejection guard in the runners — uses `SERVER_VERSION`, so the
DB's recorded version advances only when the server is released.

### Compatibility bounds

Because the client and server release independently, each side declares
the oldest counterpart it tolerates:

| Constant | Source of truth | Authority on |
|---|---|---|
| `MIN_CLIENT_VERSION` | `version.ts` | Oldest CLI/client this server will accept. |
| `MIN_SERVER_VERSION` | `version.ts` | Oldest server this CLI/client will talk to. |

Enforcement points:

- **Per-request**: the client sends `X-Client-Version: <CLIENT_VERSION>` on
  every RPC (`packages/client/transport.ts`). The server's
  `checkClientVersion` middleware (`packages/server/middleware/client-version.ts`)
  rejects too-old clients before dispatch with a JSON-RPC envelope whose
  `data.code` is `CLIENT_VERSION_INCOMPATIBLE` and HTTP status `426 Upgrade Required`.
  Missing or malformed headers are allowed through (lenient mode) so this
  feature can be rolled out without breaking older clients.
- **Probe**: `GET /api/v1/version` is unauthenticated and returns
  `{ serverVersion, minClientVersion, client?: { version, compatible } }`.
  The CLI's `checkServerVersion` helper (`packages/client/version.ts`) calls
  this on `me login` and `me version`, throwing typed `RpcError`s for both
  `CLIENT_VERSION_INCOMPATIBLE` and `SERVER_VERSION_INCOMPATIBLE`.

### Bumping `MIN_CLIENT_VERSION` / `MIN_SERVER_VERSION`

Bump these only when you intentionally break compatibility — i.e. you are
shipping a server that no longer supports an older client wire format, or a
client that requires a server feature added in a specific release.

- Bump `MIN_CLIENT_VERSION` when **the server** drops support for an older
  protocol shape. After the bump, clients below the new minimum will see
  `CLIENT_VERSION_INCOMPATIBLE` instead of confusing 4xx/5xx errors.
  The `bun run release:server` script prompts for this; you can also edit
  `version.ts` directly.
- Bump `MIN_SERVER_VERSION` when **the client** depends on a feature that
  only newer servers expose. After the bump, the client refuses to talk to
  older servers with `SERVER_VERSION_INCOMPATIBLE`.
  The `bun run release:client` script prompts for this.

Rule of thumb: pin the new minimum at the *current* counterpart version
(e.g. when releasing server `0.2.0` that drops support for protocol shapes
older than client `0.2.0`, set `MIN_CLIENT_VERSION = "0.2.0"`).

If you forget to bump, nothing breaks per se — older counterparts will fail
later with less helpful errors. Bumping is the difference between a clear
upgrade prompt and "method not found" / "invalid params" mid-command.

### Two scripts

**`bun run release:client`** — bumps the version in:

- `package.json`
- `packages/cli/package.json`
- `packages/client/package.json`
- `packages/protocol/package.json`

Then prompts whether to bump `MIN_SERVER_VERSION` in `version.ts` (leave
blank to keep the current value — see [Bumping
`MIN_CLIENT_VERSION` / `MIN_SERVER_VERSION`](#bumping-min_client_version--min_server_version)).

Commits, creates an annotated tag `v<version>`, and pushes.

The `v*` tag triggers `.github/workflows/release.yml`, which:

- Publishes `@memory.build/protocol` and `@memory.build/client` to npm.
- Builds the `me` CLI for all platforms.
- Creates a GitHub Release with the binaries.
- Publishes the CLI wrapper to npm.
- Updates the Homebrew formula.

It also triggers `.github/workflows/docs.yml`, which rebuilds and
publishes the MkDocs site from the tag's commit (see [Docs deployment](#docs-deployment)).

**`bun run release:server`** — bumps the version in the server-side packages
in lockstep:

- `packages/accounts/package.json`
- `packages/embedding/package.json`
- `packages/engine/package.json`
- `packages/server/package.json` (canonical source)
- `packages/worker/package.json`

Then prompts whether to bump `MIN_CLIENT_VERSION` in `version.ts` (leave
blank to keep the current value).

Commits, creates an annotated tag `server/v<version>`, and pushes.

The `server/v*` tag triggers `.github/workflows/deploy-prod.yaml`, which
builds the server image from `packages/server/Dockerfile` and deploys it
to prod. It also triggers `.github/workflows/docs.yml`, which rebuilds
and publishes the MkDocs site from the tag's commit (see
[Docs deployment](#docs-deployment)).

The dev environment is redeployed automatically by
`.github/workflows/deploy-dev.yaml` on every push to `main` that touches a
server path — no tag required.

### Usage

```bash
bun run release:client 0.2.0       # explicit version
bun run release:client patch       # 0.1.16 -> 0.1.17
bun run release:client minor       # 0.1.16 -> 0.2.0
bun run release:client             # prompts for version

bun run release:server patch       # same arg shapes; tags server/v<...>
```

Both scripts require:

- Clean working tree, on `main`, up to date with `origin/main`.
- Version strictly greater than the current one.
- Tag doesn't already exist.
- Explicit `y` confirmation at the prompt.

After confirmation, both scripts also prompt for an optional
`MIN_*_VERSION` bump in `version.ts`:

```
? Bump MIN_SERVER_VERSION? (current: 0.1.17, leave blank to keep):
```

Press Enter to skip (most releases). Type a semver to bump it (only when
you're intentionally breaking compatibility with older counterparts — see
[Bumping `MIN_CLIENT_VERSION` / `MIN_SERVER_VERSION`](#bumping-min_client_version--min_server_version)).
The bumped `version.ts` is included in the same commit as the package
version bumps.

### Typical workflow

Because the client and server release independently, the typical sequence
for a change that spans both sides is:

1. Land a backwards-compatible server change on `main`. Dev auto-deploys.
2. `bun run release:server` to tag `server/v<next>` and deploy prod.
3. Land the client change on `main` that depends on the new server behavior.
4. `bun run release:client` to publish the CLI and npm packages.

The server counter and the client counter will diverge over time — that's
expected. They're not related after this split.

### Docs deployment

The MkDocs site at <https://docs.memory.build/> is deployed by
`.github/workflows/docs.yml`. It is **not** auto-deployed on every push
to `main`, because the docs describe both client (CLI/MCP) and server
behavior, and `main` typically contains changes that aren't yet released
on either side.

The workflow runs on:

- Push of a `v*` tag (client release) — docs rebuild from that tag's commit.
- Push of a `server/v*` tag (server release) — docs rebuild from that tag's commit.
- `workflow_dispatch`, with an optional `ref` input (defaults to `main`)
  for publishing docs-only fixes or republishing from a specific tag/SHA.

Implications:

- A docs-only edit on `main` (e.g. a typo fix) will not appear on the
  public site until the next release tag — or until you trigger the
  workflow manually from the Actions tab.
- Cutting a release that touches behavior described in `docs/` will
  automatically refresh the public docs.
- If client and server tags land at different commits, the most recent
  tag wins (the docs reflect whatever was last deployed).

### Adding a migration

Database migrations run at server startup using `SERVER_VERSION` as the
`serverVersion` passed to the runners. When you add a new migration file under
`packages/engine/migrate/migrations/` or `packages/accounts/migrate/migrations/`:

- Cut a **server** release afterwards (`bun run release:server`) to advance
  `SERVER_VERSION` and propagate the migration to prod.
- The migration's `applied_at_version` column and the schema's `version`
  row will reflect the new `SERVER_VERSION`.
- Rolling back to an older server image will then trip the downgrade guard
  in the migration runners — by design.

## Troubleshooting

**CLI says "Failed to start device flow: HTTP 405"**

The CLI defaults to `http://localhost:3000`. If your server is on a different port, pass `--server http://localhost:<PORT>` or set `ME_SERVER`.

**Google OAuth "redirect_uri_mismatch"**

The redirect URI registered in Google Cloud Console must exactly match `<API_BASE_URL>/api/v1/auth/callback/google`, including the port.

**`API_BASE_URL` vs `PORT`**

`PORT` controls where the server listens. `API_BASE_URL` is used to build OAuth callback URLs sent to providers. If they don't match, OAuth callbacks will fail.
