# me whoami

Show current identity and active space.

## Usage

```
me whoami
```

## Description

Calls the user endpoint (`whoami`) and displays your name, email, principal ID, auth method, server URL, and active space.

The active space is shown as its display name and slug (with an `[admin]` marker when you are an admin of it) — the slug is resolved to the full space via `space.list`. If the stored active-space slug no longer matches one of your spaces (for example, you were removed), the line flags it as `(not found — …)`.

The **auth method** reflects how the current credential authenticates: `session` (a `me login` OAuth session), `api key (PAT)` (a personal access token acting as you, via `ME_API_KEY`), `agent key` (a dedicated agent key), or `service-account key` (a team-owned service-account key).

```
me whoami
  Name:   John Pruitt
  Kind:   user
  Email:  jgpruitt@gmail.com
  ID:     019d97a2-332a-7fbd-b6e1-86c7ec1045d0
  Auth:   session
  Server: https://api.memory.build
  Space:  Acme (6nnv8r3gz9jr) [admin]
```

In `--json` / `--yaml` output the active space is available both as the `activeSpace` slug (unchanged) and a resolved `space` object (`null` when unset or unresolved), alongside an `auth` field (`session` | `pat` | `agent`).

Returns an error if you are not logged in. Set or change the active space with [`me space use`](me-space.md#me-space-use).

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |
| `--json` | Output as JSON |
| `--yaml` | Output as YAML |
