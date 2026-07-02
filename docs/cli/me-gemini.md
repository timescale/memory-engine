# me gemini

Gemini CLI integration commands.

Two scopes, two commands:

- **`me gemini install`** — set up the integration **for your user**
  (`~/.gemini/`, `~/.agents/skills/`). Runs as **you**.
- **`me gemini init`** — set up **this project** (`.gemini/`, `.agents/skills/`,
  repo `GEMINI.md`). Runs as the **project's agent** (`.me` `agent`).

## Commands

- [me gemini install](#me-gemini-install) -- user-scope setup (MCP + capture hooks + skill + command + pointer)
- [me gemini init](#me-gemini-init) -- project-scope setup, acting as the project's `.me` agent (+ git history + backfills)
- [me gemini hook](#me-gemini-hook) -- invoked by the capture hooks (not run by hand)
- [me gemini import](#me-gemini-import) -- import Gemini CLI sessions from `~/.gemini/tmp`

---

## me gemini install

Set up the Gemini integration for your user. Writes into
`~/.gemini/settings.json`: the MCP server (`mcpServers.me`) and capture hooks;
plus the `memory-engine` skill (shared `~/.agents/skills/`), the `/memory-recall`
TOML command, and a memory pointer in `~/.gemini/GEMINI.md`. Runs as **you**.

```
me gemini install [options]
```

| Option | Description |
|--------|-------------|
| `--server <url>` | Pin a server into the MCP config. |
| `--space <slug>` | Pin a space into the MCP config. Implies `--server`. |
| `--remove` | Remove the user-scope integration. |

The MCP entry is written as JSON directly (not via `gemini mcp add`) so no
binary is required.

---

## me gemini init

Set up **this project**, acting as the project's agent. Requires a
`.me/config.yaml` with an `agent:` (fails fast otherwise). Steps (picker in a
TTY; else every step minus its `--skip-*` flag):

- **Import this project's existing Gemini sessions** (one-time backfill)
- **Register the MCP server + capture hooks** in `.gemini/settings.json` (`AfterAgent` + `SessionEnd`)
- **Inject `ME_AS_AGENT=.me`** into `.gemini/.env` (ad-hoc `me` runs as the agent)
- **Install the `/memory-recall` command** and the **`memory-engine` skill**
- **Import git history** + **install a git post-commit hook** (act as the agent)
- **Add a memory pointer to GEMINI.md**

All baked `me` invocations carry `--as-agent .me`. (A repo can also surface the
shared `AGENTS.md` block to Gemini by setting `context.fileName` to include
`AGENTS.md`.)

---

## me gemini hook

Invoked by the capture hooks in `settings.json` (reads the event JSON from
stdin) to import the session — the same path as `me gemini import`, incremental.
Not run by hand.

```
me gemini hook --event <after-agent|session-end> [--scope <user|project>] [--full-transcript]
```

Best-effort: always exits 0.

---

## me gemini import

Import Gemini CLI sessions from `~/.gemini/tmp`. Alias of
[`me import gemini`](./me-import.md).
