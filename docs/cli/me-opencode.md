# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- register `me` as an MCP server with OpenCode
- [me opencode init](#me-opencode-init) -- one-shot per-project setup (backfill + capture plugin + MCP + AGENTS.md)
- [me opencode hook](#me-opencode-hook) -- invoked by the capture plugin to import a session (not run by hand)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/storage`

---

## me opencode install

Register `me` as an MCP server with OpenCode by editing `~/.config/opencode/opencode.json`.

```
me opencode install [options]
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `--scope <scope>` | Where to write the config: `project` (`./opencode.json` at the repo root) or `user` (`~/.config/opencode/opencode.json`). Default: `user`. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create --agent <agent>`, or `me apikey create` for a personal access token) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

Use `--scope project` to write the `mcp.me` entry into the repo's `opencode.json` (instead of your global config) so it can be committed and shared with your team. Don't combine `--scope project` with a baked `--api-key` unless you intend to commit that key.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me opencode init

One-shot setup of OpenCode memory integration for the current project. Interactive runs present a grouped, pre-checked step picker; non-interactive runs execute every step except those turned off by a `--skip-*` flag.

```
me opencode init [options]
```

Steps:

| Step | Kind | What it does |
|------|------|--------------|
| Import OpenCode sessions | backfill | Import this project's existing sessions (one-time) |
| Install the capture plugin | ongoing | Write a small plugin into `~/.config/opencode/plugins/memory-engine.ts` that captures new sessions on `session.idle` / `session.deleted` |
| Register the MCP server | config | Same as `me opencode install` -- gives OpenCode the memory tools |
| Install `/memory-recall` | config | A custom command that searches Memory Engine |
| Install the `memory-engine` skill | config | A `SKILL.md` teaching the agent when/how to use memory |
| Import git history | backfill | Import the repo's git commit history (one-time) |
| Install the git post-commit hook | ongoing | Capture new commits going forward |
| Add a memory pointer to AGENTS.md | config | Write a managed block telling the agent where this project's memories live |

| Option | Description |
|--------|-------------|
| `--scope <scope>` | `project` (`.opencode/` + `opencode.json` in the repo) or `user` (`~/.config/opencode/`). Default: `project`; prompted interactively when unset in a TTY. |
| `--skip-session-import` | do not import this project's OpenCode sessions |
| `--skip-plugin-install` | do not install the OpenCode capture plugin |
| `--skip-mcp-install` | do not register `me` as an MCP server |
| `--skip-recall-command` | do not install the `/memory-recall` command |
| `--skip-skill` | do not install the `memory-engine` skill |
| `--skip-git-import` | do not import the repo's git commit history |
| `--skip-git-hook` | do not install the git post-commit hook |
| `--skip-agents-md` | do not write the memory pointer into AGENTS.md |

**Scope.** `init` is per-project, so it defaults to `project` scope: the plugin, MCP entry, command, and skill are written under the repo (`.opencode/plugins/`, `.opencode/commands/`, `.opencode/skills/`, and `opencode.json`), so you can commit them and the whole team gets memory integration. This is safe to commit because no API key is embedded — each teammate's own `me login` (or `ME_API_KEY`/`ME_SPACE`) resolves at runtime. Pass `--scope user` to install into your global `~/.config/opencode/` instead. The AGENTS.md memory pointer is always written at the repo root regardless of scope.

The capture plugin shells out to `me opencode hook`, which reuses your `me login` session (or `ME_API_KEY` + `ME_SPACE`) -- no API key needs to be embedded in the plugin. The `me` CLI must be on `PATH` where OpenCode runs.

---

## me opencode hook

Invoked by the generated capture plugin on `session.idle` and `session.deleted`; not meant to be run by hand. It resolves the session id to its storage file and imports it via the same incremental path as `me import opencode`, so live captures and bulk imports reconcile onto the same memories.

```
me opencode hook --event <idle|deleted> --session <id> [options]
```

| Option | Description |
|--------|-------------|
| `--event <name>` | hook event name (`idle`, `deleted`) |
| `--session <id>` | OpenCode session id (e.g. `ses_abc123`) |
| `--storage <dir>` | OpenCode storage dir (default: standard location) |
| `--full-transcript` | also store reasoning + tool calls/results |

Best-effort: it logs failures to stderr but always exits 0, so a capture failure never blocks an OpenCode session.

---

## me opencode import

Import OpenCode sessions from `~/.local/share/opencode/storage/`. This is an alias of [`me import opencode`](me-import.md#me-import-claude--codex--opencode).

```
me opencode import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

OpenCode stores data across four directories:

- `project/<project-id>.json` -- project metadata
- `session/<project-id>/ses_<id>.json` -- session metadata (title, directory, timestamps)
- `message/ses_<id>/msg_<id>.json` -- per-message metadata (role, model)
- `part/msg_<id>/prt_<id>.json` -- content parts (text, reasoning, tool, step-start/finish)

Each `msg_<id>` becomes one memory. Parts are stitched into the message's ordered block list (text / reasoning / tool_use + tool_result). OpenCode's `agent` field becomes `meta.source_agent_mode` (e.g. `"plan"`).

Synthetic OpenCode user text wrapper parts marked with `synthetic: true` are ignored.
