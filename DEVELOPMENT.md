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
| `bun run clean` | Remove build artifacts |
| `bun run generate:master-key` | Generate a new encryption master key |

## Troubleshooting

**CLI says "Failed to start device flow: HTTP 405"**

The CLI defaults to `http://localhost:3000`. If your server is on a different port, pass `--server http://localhost:<PORT>` or set `ME_SERVER`.

**Google OAuth "redirect_uri_mismatch"**

The redirect URI registered in Google Cloud Console must exactly match `<API_BASE_URL>/api/v1/auth/callback/google`, including the port.

**`API_BASE_URL` vs `PORT`**

`PORT` controls where the server listens. `API_BASE_URL` is used to build OAuth callback URLs sent to providers. If they don't match, OAuth callbacks will fail.
