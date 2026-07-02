# me codex

Codex CLI integration commands.

Two scopes, two commands:

- **`me codex install`** — set up the integration **for your user**
  (`~/.codex/`, `~/.agents/skills/`). Runs as **you**.
- **`me codex init`** — set up **this project** (`.codex/`, `.agents/skills/`,
  repo `AGENTS.md`). Runs as the **project's agent** (`.me` `agent`).

## Commands

- [me codex install](#me-codex-install) -- user-scope setup (MCP + capture hook + skills + pointer)
- [me codex init](#me-codex-init) -- project-scope setup, acting as the project's `.me` agent (+ git history + backfills)
- [me codex hook](#me-codex-hook) -- invoked by the Codex Stop hook (not run by hand)
- [me codex import](#me-codex-import) -- import Codex sessions from `~/.codex/sessions`

---

## me codex install

Set up the Codex integration for your user. Writes: the MCP server
(a managed `[mcp_servers.me]` block in `~/.codex/config.toml`), the capture
hook (`hooks.json`), the `memory-engine` + `memory-recall` skills (in the shared
`~/.agents/skills/` — Codex custom prompts are deprecated, so recall ships as a
skill), and a memory pointer in `~/.codex/AGENTS.md`. Runs as **you**.

```
me codex install [options]
```

| Option | Description |
|--------|-------------|
| `--server <url>` | Pin a server into the MCP config. |
| `--space <slug>` | Pin a space into the MCP config. Implies `--server`. |
| `--remove` | Remove the user-scope integration. |

---

## me codex init

Set up **this project**, acting as the project's agent. Requires a
`.me/config.yaml` with an `agent:` (fails fast otherwise). Steps (picker in a
TTY; else every step minus its `--skip-*` flag):

- **Import this project's existing Codex sessions** (one-time backfill)
- **Install the capture hook** in `.codex/hooks.json` (Codex's turn-end `Stop`)
- **Register the MCP server** + a `[shell_environment_policy]` injecting `ME_AS_AGENT=.me` — both in `.codex/config.toml`
- **Install the `memory-engine` + `memory-recall` skills** (`.agents/skills/`)
- **Import git history** + **install a git post-commit hook** (act as the agent)
- **Add a memory pointer to AGENTS.md**

Codex gates project `.codex/` config behind **trusting the project**, and a new
capture hook needs a one-time approval (`/hooks`) — `init` prints a reminder.
All baked `me` invocations carry `--as-agent .me`.

---

## me codex hook

Invoked by the Codex `Stop` hook (reads the event JSON from stdin) to import
the session rollout — the same path as `me codex import`, incremental. Not run
by hand.

```
me codex hook --event stop [--scope <user|project>] [--full-transcript]
```

Best-effort: always exits 0.

---

## me codex import

Import Codex sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`.
Alias of [`me import codex`](./me-import.md).
