# Development

## Prerequisites

- [Bun](https://bun.sh) (latest)
- [Docker](https://www.docker.com/) (for PostgreSQL)

## Quick Start against dev

### 1. Clone the repo

```bash
git clone git@github.com:timescale/memory-engine.git
cd memory-engine
```

### 2. Install

```bash
./bun install
./bun run install:local
```

### 3. Log in and install the Claude Code plugin

```bash
me --server https://me.dev-us-east-1.ops.dev.timescale.com login
me claude install --dev
```

Login must come first: `me claude install` needs your session and the
stored server URL. `--dev` installs the Claude Code plugin from your local
checkout (run it from inside the repo) instead of the published
marketplace — with it installed, `me claude init` won't offer to install
the published plugin over it.

After that follow the instructions from login. The next step will probably
be `me claude init` in whatever project you are working in. Don't test on
memory-engine itself as that can be confusing for the model.

## Quick Start

```bash
./bun install
./bun run pg:docker
# configure .env (see below)
./bun run setup
./bun run server
# in another terminal:
./bun run packages/cli/index.ts --server http://localhost:3000 login
```

## Step by Step

### 1. Install dependencies

```bash
./bun install
```

### 2. Start PostgreSQL

The project requires PostgreSQL 18 with three extensions: `pgvector`, `pg_textsearch`, and `ltree`. The included Dockerfile builds a pre-configured image:

```bash
./bun run pg:docker
```

This builds the Docker image and starts a container named `me-postgres` on `localhost:5432` with trust authentication (no password). It serves the default `postgres` database, which is the one `.env.sample` targets.

Other database commands:

| Command | Description |
|---|---|
| `./bun run pg:rm` | Stop and remove the container |
| `./bun run psql` | Connect with psql |

### 3. Configure `.env`

Copy the sample and fill in the required values:

```bash
cp .env.sample .env
```

#### Required variables

**Database connection** — one database holds the `auth` + `core` control plane and every per-space `me_<slug>` schema:

```
DATABASE_URL=postgres://postgres@localhost:5432/postgres
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
DATABASE_URL=postgres://postgres@localhost:5432/postgres

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

Optional runtime database timeout knobs are listed in `.env.sample`. They are
specified in milliseconds, for example `RPC_DB_STATEMENT_TIMEOUT_MS=30000`.

### 4. Run setup

```bash
./bun run setup
```

This is idempotent (safe to run multiple times). It reads `DATABASE_URL` and
creates that database if it doesn't already exist (everything else —
bootstrap, migrations, encryption keys — happens automatically at server
startup). When `DATABASE_URL` targets `/postgres` (the `me-postgres`
container's default database, as in `.env.sample`), this is effectively a
no-op since that database already exists — running it is still harmless.

### 5. Start the server

```bash
./bun run server
```

### 5b. Run the server in Docker (optional)

To exercise the actual production image locally — the multi-stage
`packages/server/Dockerfile` that CI builds and deploys — use the `server:*`
scripts (the Docker counterparts to `pg:*`):

```bash
./bun run server:docker   # build the image + run in the foreground (me-server)
./bun run server:build    # build the image only
./bun run server:rm       # force-remove the container (only needed if it leaks)
```

`server:docker` runs the container in the **foreground** (`--rm -t`): logs
scroll in the terminal, `Ctrl+C` triggers the server's graceful shutdown, and
the container is removed on exit. It publishes the server on `127.0.0.1:3000`
and wires it to the `me-postgres` container. Prerequisites:

- Postgres running (`./bun run pg:docker`).
- A populated `.env` (the container is started with `--env-file .env`, so it
  reads `EMBEDDING_API_KEY`, the OAuth credentials, telemetry, etc. from there).

How it reaches Postgres: the script overrides `DATABASE_URL` to
`postgres://postgres@host.docker.internal:5432/postgres` (and adds
`--add-host=host.docker.internal:host-gateway` so the hostname resolves on
Linux too). A container can't reach the host's `localhost`, so this override
replaces the `localhost` value your `.env` uses for host-run development.
`-e` takes precedence over `--env-file`, so the rest of `.env` still applies.

Caveats:

- The script hardcodes port `3000`. If you set a different `PORT` in `.env`,
  edit the `server:docker` script's published port and keep `API_BASE_URL`
  consistent.
- The override only covers `DATABASE_URL`. If you uncomment
  `WORKER_DATABASE_URL` in `.env`, it must also use `host.docker.internal`.
- `docker run --env-file` parses literal `KEY=VALUE` lines — no quotes, no
  `$VAR` expansion (unlike Bun's `.env` loader). `.env.sample` is already
  compatible.

### 6. Test with the CLI

In another terminal:

```bash
./bun run packages/cli/index.ts --server http://localhost:3000 login
```

Or set `ME_SERVER` to avoid passing `--server` every time:

```bash
export ME_SERVER=http://localhost:3000
./bun run packages/cli/index.ts login
```

After login, the server URL is stored as the default in `~/.config/me/credentials.yaml`, so subsequent commands don't need `--server`.

## All Commands

| Command | Description |
|---|---|
| `./bun run server` | Start the server (on the host) |
| `./bun run setup` | Ensure the `DATABASE_URL` database exists |
| `./bun run pg:docker` | Build and start PostgreSQL in Docker |
| `./bun run pg:rm` | Stop and remove the PostgreSQL container |
| `./bun run psql` | Connect to PostgreSQL with psql |
| `./bun run server:build` | Build the server Docker image (`me-server`) |
| `./bun run server:docker` | Build + run the server in Docker (vs `me-postgres`) |
| `./bun run server:rm` | Stop and remove the server container |
| `./bun run test` | Run all package tests (unit + integration, vs local Postgres by default) |
| `./bun run check` | Fast inner loop: typecheck + lint + unit tests (no database) |
| `./bun run check:full` | Everything: check + full suite + e2e (vs local Postgres by default) |
| `./bun run build` | Compile CLI binary (current platform) |
| `./bun run build:all` | Cross-compile CLI for all platforms |
| `./bun run install:local` | Build and install local CLI binary to your PATH |
| `./bun run clean` | Remove build artifacts |
| `./bun run generate:master-key` | Generate a new encryption master key |
| `./bun run release:client` | Cut a client release (CLI + npm packages) |
| `./bun run release:server` | Cut a server release (deploys to prod) |

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
  The `./bun run release:server` script prompts for this; you can also edit
  `version.ts` directly.
- Bump `MIN_SERVER_VERSION` when **the client** depends on a feature that
  only newer servers expose. After the bump, the client refuses to talk to
  older servers with `SERVER_VERSION_INCOMPATIBLE`.
  The `./bun run release:client` script prompts for this.

Rule of thumb: pin the new minimum at the *current* counterpart version
(e.g. when releasing server `0.2.0` that drops support for protocol shapes
older than client `0.2.0`, set `MIN_CLIENT_VERSION = "0.2.0"`).

If you forget to bump, nothing breaks per se — older counterparts will fail
later with less helpful errors. Bumping is the difference between a clear
upgrade prompt and "method not found" / "invalid params" mid-command.

### Two scripts

**`./bun run release:client`** — bumps the version in:

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
publishes the docs site from the tag's commit (see [Docs deployment](#docs-deployment)).

**`./bun run release:server`** — bumps the version in the server-side packages
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
and publishes the docs site from the tag's commit (see
[Docs deployment](#docs-deployment)).

The dev environment is redeployed automatically by
`.github/workflows/deploy-dev.yaml` on every push to `main` that touches a
server path — no tag required.

### Usage

```bash
./bun run release:client 0.2.0       # explicit version
./bun run release:client patch       # 0.1.16 -> 0.1.17
./bun run release:client minor       # 0.1.16 -> 0.2.0
./bun run release:client             # prompts for version

./bun run release:server patch       # same arg shapes; tags server/v<...>
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
2. `./bun run release:server` to tag `server/v<next>` and deploy prod.
3. Land the client change on `main` that depends on the new server behavior.
4. `./bun run release:client` to publish the CLI and npm packages.

The server counter and the client counter will diverge over time — that's
expected. They're not related after this split.

### Docs deployment

The docs site at <https://docs.memory.build/> (built from `packages/docs-site/`) is deployed by
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

Migrations live under `packages/database/{auth,core,space}/migrate/` in two
flavors: `incremental/` (versioned DDL, applied exactly once per schema,
tracked by name) and `idempotent/` (function/index definitions, re-applied on
every migrate run via `create or replace`).

Migrations run at server startup (`startServer`, unless `migrate: false`):
the `auth` and `core` schemas are migrated, then **every existing space
schema is re-migrated** (enumerated from `core.space`) so changes to the
idempotent space SQL reach already-provisioned spaces on the next deploy —
spaces are otherwise only migrated once, when provisioned. A failed space
re-migration aborts boot; concurrent replica boots are serialized by a
per-schema advisory lock.

Rolling back to an older server image trips the downgrade guard in the
migration runners (stamped schema version newer than the app's) — by design.

## Hosted web UI

The web UI (`packages/web`) runs in two modes from a **single build**:

- **local** — served by `me serve`, which proxies a same-origin `/rpc` and
  injects the session token + active space. The browser carries no credentials.
- **hosted** — served by the API server itself (same-origin). The browser
  authenticates with an **httpOnly session cookie** and picks its own space.

The hosted server serves the built UI from **root `/`** (the server reads it from
`WEB_DIST`, default `packages/web/dist`; the multi-stage `packages/server/Dockerfile`
builds it and copies `dist` into the image). Routing is explicit: an unknown
`/api/*` path returns a JSON 404; any other GET/HEAD is served by the static
resolver (asset → file, else the SPA `index.html`). The server injects
`window.__ME_BOOTSTRAP__ = { mode: "hosted" }` into `index.html` so the same
build knows it's hosted — `me serve` and the Vite dev server inject nothing and
stay local, so neither is affected.

Browser auth reuses the existing opaque session token, carried in the cookie
instead of an `Authorization` header. Login is a full-page redirect:
`GET /api/v1/auth/login/:provider` → OAuth → the callback mints a session, sets
the cookie, and 302s back into the app; `POST /api/v1/auth/logout` clears it.
Cookie-authenticated requests must carry an allowed `Origin` (CSRF gate); header
(Bearer / api-key) credentials are exempt.

**Env:**

- `WEB_DIST` — directory of the built UI (default `packages/web/dist`).
- `WEB_ALLOWED_ORIGINS` — comma-separated extra origins allowed for
  cookie-authenticated requests. The public origin (from `API_BASE_URL`) is
  always allowed; use this to permit a second origin during a cutover.

**Local hosted-mode smoke:** build the UI (`cd packages/web && ../../bun run build`),
then run the server with `API_BASE_URL=http://localhost:3000` +
`WEB_DIST=packages/web/dist` and open `http://localhost:3000`. (Over plain HTTP
the cookie name is `me_session`; over HTTPS it's `__Host-me_session`.)

### Developing the web UI (hot reload)

`me serve` and the hosted server both serve the **built** UI, so neither
reflects in-progress source edits. For that, run the **Vite dev server**
(`./bun run web`, port 5173) — it serves `packages/web/src` with hot-module
reload. Vite is *only* a frontend, though: it proxies `/rpc` + `/healthz` to a
backend (default `http://localhost:3000`) and injects no credentials, so
something must answer those paths. Two ways to supply that backend:

- **Local backend** — run the API server (`./bun run server`, needs local
  Postgres + `.env`) on `:3000`, then `./bun run web` in another terminal. Edits
  hot-reload against your local data.
- **Remote backend (e.g. production), no local server** — one command:

  ```bash
  ./bun run web:remote          # defaults to https://api.memory.build
  ME_SERVER=https://… ./bun run web:remote   # or any other backend
  ```

  Open `http://localhost:5173`. This is hot-reloading UI against **live**
  production data — writes/deletes are real.

  `web:remote` (`scripts/web-remote.ts`) spawns `me serve` on an auto-picked
  free port, points the Vite dev server at it via `ME_DEV_RPC_TARGET`, and tears
  both down together on Ctrl+C (or if either exits — e.g. `me serve` failing
  because you're not logged in). `me serve` is what proxies `/rpc` to the remote
  `…/api/v1/memory/rpc` and injects your OAuth token + active space, so the
  browser stays credential-free.

**`ME_DEV_RPC_TARGET`** (read in `packages/web/vite.config.ts`) overrides the
proxy target; set it when `:3000` is occupied. Prefer an explicit `127.0.0.1`
over `localhost` to avoid IPv4/IPv6 ambiguity when an unrelated service also
holds `:3000`. Both `me serve` and the Vite dev server run the UI in **local**
mode (neither injects `window.__ME_BOOTSTRAP__`), so behavior matches production
aside from hot reload.

### Moving the hosted UI to `app.memory.build`

The design keeps this to **config + ingress — no application code changes** (the
cookie is host-only, the web client uses a relative URL, and origins/redirects
come from config). The two subdomains share the registrable domain
`memory.build`, so they're the *same site*: `SameSite=Lax` cookies still flow and
there's no CORS. Steps:

1. **Ingress** (in the `tiger-agents-deploy` helm repo — separate repo): add the
   `app.memory.build` host and route `/api/*` + `/health` + `/ready` → the
   memory-engine server Service, and everything else → the server too (it serves
   the UI). The browser sees a single origin, so it stays same-origin (no CORS).
2. **Server config:** set `API_BASE_URL=https://app.memory.build` (this drives the
   OAuth redirect URI and the default allowed origin). During a cutover where
   both hosts must work, add the other origin via `WEB_ALLOWED_ORIGINS`.
3. **OAuth providers:** register `https://app.memory.build/api/v1/auth/callback/{github,google}`
   as authorized redirect URIs in the GitHub / Google app settings.

The cookie is host-only (no `Domain`), so it automatically scopes to whichever
host serves the page — nothing to change there. If you ever wanted a *different*
registrable domain (not a `memory.build` subdomain), that's the expensive case
(`SameSite=None; Secure`, CORS with credentials, third-party-cookie exposure) and
would likely need a token scheme instead — out of scope for the subdomain move.

## Troubleshooting

**CLI says "Failed to start device flow: HTTP 405"**

The CLI defaults to `http://localhost:3000`. If your server is on a different port, pass `--server http://localhost:<PORT>` or set `ME_SERVER`.

**Google OAuth "redirect_uri_mismatch"**

The redirect URI registered in Google Cloud Console must exactly match `<API_BASE_URL>/api/v1/auth/callback/google`, including the port.

**`API_BASE_URL` vs `PORT`**

`PORT` controls where the server listens. `API_BASE_URL` is used to build OAuth callback URLs sent to providers. If they don't match, OAuth callbacks will fail.
