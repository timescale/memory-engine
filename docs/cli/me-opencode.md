# me opencode

OpenCode integration commands.

Two scopes, two commands:

- **`me opencode install`** — set up the integration **for your user**
  (`~/.config/opencode/`). Runs as **you**.
- **`me opencode init`** — set up **this project** (`.opencode/` + repo
  `opencode.json` / `AGENTS.md`). Runs as the **project's agent** (`.me` `agent`).

## Commands

- [me opencode install](#me-opencode-install) -- user-scope setup (MCP + capture plugin + skill + command + pointer)
- [me opencode init](#me-opencode-init) -- project-scope setup, acting as the project's `.me` agent (+ git history + backfills)
- [me opencode hook](#me-opencode-hook) -- invoked by the capture plugin (not run by hand)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/storage`

---

## me opencode install

Set up the OpenCode integration for your user. Writes: the MCP server
(`mcp.me` in `~/.config/opencode/opencode.json`), the capture plugin, the
`memory-engine` skill (in the shared `~/.agents/skills/`), the `/memory-recall`
command, and a memory pointer in `~/.config/opencode/AGENTS.md`. Runs as **you**.

```
me opencode install [options]
```

| Option | Description |
|--------|-------------|
| `--server <url>` | Pin a server into the MCP config. |
| `--space <slug>` | Pin a space into the MCP config. Implies `--server`. |
| `--remove` | Remove the user-scope integration. |

By default nothing is baked — `me mcp` resolves your session + active space at
runtime. See [Project config](../project-config.md#precedence) for the pin caveat.

---

## me opencode init

Set up **this project**, acting as the project's agent. Requires a
`.me/config.yaml` with an `agent:` (fails fast otherwise). Grouped, pre-checked
steps (picker in a TTY; else every step minus its `--skip-*` flag):

- **Import this project's existing OpenCode sessions** (one-time backfill)
- **Install the capture plugin** in `.opencode/plugins/` — captures new sessions, and exports a `shell.env` hook injecting `ME_AS_AGENT=.me` into tool shells
- **Register the MCP server** in `opencode.json` (`me --as-agent .me mcp`)
- **Install the `/memory-recall` command** and the **`memory-engine` skill**
- **Import git history** + **install a git post-commit hook** (act as the agent)
- **Add a memory pointer to AGENTS.md** (templated from `.me/config.yaml`)

All baked `me` invocations carry `--as-agent .me`.

---

## me opencode hook

Invoked by the generated capture plugin on `session.idle` / `session.deleted`
to import the session — the same path as `me opencode import`, incremental.
Not run by hand.

```
me opencode hook --event <idle|deleted> --session <id> [--scope <user|project>] [--tree-root <ltree>] [--full-transcript]
```

`--scope` drives the double-capture dedup (a user-scope hook defers when a
project-scope plugin is installed). Best-effort: always exits 0.

---

## me opencode import

Import OpenCode sessions from `~/.local/share/opencode/storage`. Alias of
[`me import opencode`](./me-import.md).
