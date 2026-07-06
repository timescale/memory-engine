# Self-Hosting Memory Engine

Run your own Memory Engine backend with Docker Compose, and build the `me` CLI
from source to use it.

There are **two pieces, and you need both**:

1. **The backend stack** — the server + PostgreSQL, started with the
   `compose.yaml` in this repo. This is just the backend; on its own it does
   nothing useful.
2. **A client** — the `me` CLI (or any MCP client) pointed at the backend. The
   stack is only reachable once a client connects to it.

A typical setup keeps `docker compose up` running in one terminal and uses the
`me` CLI from another.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose (`docker compose`).
- A Git checkout of this repository (the bundled `./bun` wrapper installs the
  pinned Bun version for you — no separate Bun install needed).
- An embedding API key — an OpenAI key, or a compatible provider.
- At least one OAuth app for login — GitHub and/or Google.

## 0. Get the code at a tagged release

Build **everything** — the compose stack and the CLI — from the same tagged
release commit. The server and CLI version counters diverge over time and the
client/server handshake enforces a minimum version on each side, so a single
released commit is the only combination guaranteed to be compatible. Don't run a
real deployment off `main`, which can sit mid-flight between releases.

```bash
git clone https://github.com/timescale/memory-engine
cd memory-engine
git fetch --tags
# Check out the latest server release (server/vX.Y.Z):
git checkout "$(git tag -l 'server/v*' | sort -V | tail -1)"
```

To pin a specific version instead, browse the
[releases](https://github.com/timescale/memory-engine/releases) and
`git checkout server/vX.Y.Z`.

## 1. Configure `.env`

```bash
cp .env.sample .env
```

Set the required values:

- `EMBEDDING_API_KEY` — your OpenAI (or compatible) API key.
- Optional: `EMBEDDING_TOKENIZE_THREADS` controls worker threads used for OpenAI
  tokenization/truncation. It auto-sizes by default
  (`max(1, min(available CPU cores - 1, 4))`); set `0` to run inline in very
  small environments.
- `POSTGRES_PASSWORD` — the password for the bundled Postgres container. Use a
  URL-safe value (letters/digits) so it needs no encoding in the connection
  string. `compose.yaml` refuses to start if this is unset.
- `API_BASE_URL=http://localhost:3000` — keep this consistent with the
  published port (see [Notes](#notes--troubleshooting)).
- `BETTER_AUTH_SECRET` — signing secret for session cookies and the JWKS keys.
  The server refuses to boot without it, and `compose.yaml` refuses to start if
  it's unset. Generate one with `openssl rand -base64 32`.
- At least one OAuth provider (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` and/or
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). When creating the app, set the
  authorized callback URL to match `API_BASE_URL`:
  - **GitHub** — create at <https://github.com/settings/developers>
    ([guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)).
    Callback: `http://localhost:3000/api/v1/auth/callback/github`
  - **Google** — create at <https://console.cloud.google.com/apis/credentials>
    ([guide](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)).
    Callback: `http://localhost:3000/api/v1/auth/callback/google`

## 2. Start the backend

```bash
docker compose up --build
```

This builds the Postgres image (`docker/Dockerfile.postgres`) and the server
image (`packages/server/Dockerfile`), then starts both. The server:

- listens on <http://localhost:3000>,
- runs database migrations automatically on boot,
- connects to Postgres over the internal compose network (the database is
  **not** exposed to the host by default).

Postgres data persists in the `pgdata` Docker volume across restarts.

## 3. Build the CLI

From the same checkout (so the CLI matches your server version):

```bash
./bun install
./bun run install:local
```

`install:local` builds the `me` binary and installs it to `~/.local/bin` (set
`ME_INSTALL_DIR` to override). Add that directory to your `PATH` if it isn't
already:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Alternatively, just build it and run the binary in place:

```bash
./bun run build            # produces packages/cli/dist/me
./packages/cli/dist/me --help
```

## 4. Connect and log in

Point the CLI at your self-hosted server and authenticate:

```bash
export ME_SERVER=http://localhost:3000
me login
```

`me login` opens a browser to complete the OAuth flow with the provider you
configured. After logging in, your server URL is saved as the default, so later
commands don't need `ME_SERVER`. Try it:

```bash
me memory create "Auth uses bcrypt with cost 12" --tree share.design.auth
me memory search "how does authentication work"
```

Keep `docker compose up` running while you use the CLI — the backend stack and
the CLI are separate processes.

## Lifecycle

| Task | Command |
|---|---|
| Stop (keep data) | `docker compose down` |
| Stop and wipe the database | `docker compose down -v` (deletes the `pgdata` volume) |
| Follow server logs | `docker compose logs -f server` |
| Update | `git fetch --tags && git checkout server/vX.Y.Z`, then `docker compose up --build` and rebuild the CLI (`./bun run install:local`) |

## Notes / troubleshooting

- **Keep ports consistent.** `API_BASE_URL`, the server's `PORT` (default 3000),
  and the published port in `compose.yaml` (`3000:3000`) must agree. To run on a
  different port, change all three, and update your OAuth callback URLs to match.
- **OAuth callback must match `API_BASE_URL` exactly**, including the port.
- **`POSTGRES_PASSWORD` only takes effect on first database init** (an empty
  `pgdata` volume). Changing it later has no effect unless you wipe the volume
  (`docker compose down -v`) or alter the role inside Postgres.
- **The database isn't exposed to the host** by default. To connect with `psql`,
  uncomment the `ports` block under the `postgres` service in `compose.yaml`.
- **Version mismatch errors** at login or on RPC calls usually mean the CLI and
  server were built from different commits. Rebuild both from the same
  `server/v*` tag (see [step 0](#0-get-the-code-at-a-tagged-release)).
- **Embedding provider rate limits (HTTP 429).** The embedding worker backs off
  and retries on its own — its visibility-timeout requeue plus a pool-wide
  backoff are the single retry authority — so `EMBEDDING_MAX_RETRIES` defaults
  to `0` (the Vercel AI SDK's own internal retry ladder is disabled). Leave it
  at `0`; under a sustained 429 the worker pauses and resumes automatically when
  the provider recovers. Set it `>0` only if you specifically want the SDK to
  retry individual calls on top of the worker's own logic.
