# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- register `me` as an MCP server with OpenCode, install the capture plugin + `/memory-recall` command + `memory-engine` skill
- [me opencode init](#me-opencode-init) -- removed; use [`me project init`](me-project.md)
- [me opencode hook](#me-opencode-hook) -- internal helper (you never run this directly)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/opencode.db` or legacy storage

---

## me opencode install

Set up OpenCode: register `me` as an MCP server (editing `~/.config/opencode/opencode.json`), install the user-scope capture plugin (inert until you opt in) plus the `/memory-recall` command and the `memory-engine` skill, and ask whether to capture your OpenCode sessions — mirroring [`me claude install`](me-claude.md#me-claude-install)'s one-install model. This same flow is also what [`me project init`](me-project.md#preflight)'s preflight offers when it detects OpenCode installed but not yet set up.

```
me opencode install [options]
```

A session (non-headless) install provisions a default agent (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field); no-op if a valid custom global `agent:` or `.user` opt-out is already set, or with `--api-key`; stale global agents prompt to be created interactively or fail clearly non-interactively; skip with `--no-default-agent`), then ends with the shared **capture prompt** (default **no**): say yes and it enables the machine-wide `capture: true` and runs a one-time machine-wide [`me import opencode`](me-import.md) backfill — everything lands privately under `~/projects/<slug>`. Say no and you get the tools only; the capture plugin stays inert. Re-run `me opencode install` to change the answer; a project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) overrides per project. A headless (`--api-key`) install skips the default agent + prompt — capture is credential-agnostic, so a headless deployment opts in via a committed `.me` `capture: true` or the target machine's config.

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for a headless agent. Default: the MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Server URL to embed in the MCP config. |
| `--scope <scope>` | Where to write the config: `project` (`./opencode.json` at the repo root) or `user` (`~/.config/opencode/opencode.json`). Default: `user`. |
| `--no-default-agent` | Skip provisioning the default agent. |

By default only the server URL is baked into the config: at runtime `me mcp` uses your `me login` session (resolved from the OS keychain / `~/.config/me` each run, so it survives re-login) and your active space (set by `me space use` / `ME_SPACE`). Pass `--api-key` (mint one with `me apikey create --agent <agent>`, or `me apikey create` for a personal access token) for a headless agent that cannot reach your keychain; that bakes the key and requires a pinned `--space`.

Use `--scope project` to write the `mcp.me` entry into the repo's `opencode.json` (instead of your global config) so it can be committed and shared with your team. Don't combine `--scope project` with a baked `--api-key` unless you intend to commit that key.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me opencode init

**Removed** — run [`me project init`](me-project.md), the harness-agnostic per-project setup wizard. The retired command prints an error and exits without running the wizard.

---

## me opencode hook

An internal helper the OpenCode capture plugin runs automatically as a session progresses. When capture is on, it imports the session as memories via the same incremental path as `me import opencode`, so live captures and bulk imports reconcile onto the same memories. **You never run this by hand** — it's best-effort and never blocks an OpenCode session.

---

## me opencode import

Import OpenCode sessions from the current SQLite database at `~/.local/share/opencode/opencode.db`, falling back to the legacy JSON storage tree at `~/.local/share/opencode/storage/`. This is an alias of [`me import opencode`](me-import.md#me-import-claude--codex--opencode).

```
me opencode import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

Current OpenCode stores data in SQLite tables: `project`, `session`, `message`, and `part`. Older OpenCode releases stored the same logical data across four directories:

- `project/<project-id>.json` -- project metadata
- `session/<project-id>/ses_<id>.json` -- session metadata (title, directory, timestamps)
- `message/ses_<id>/msg_<id>.json` -- per-message metadata (role, model)
- `part/msg_<id>/prt_<id>.json` -- content parts (text, reasoning, tool, step-start/finish)

Each `msg_<id>` becomes one memory. Parts are stitched into the message's ordered block list (text / reasoning / tool_use + tool_result). OpenCode's `agent` field becomes `meta.source_agent_mode` (e.g. `"plan"`).

Synthetic OpenCode user text wrapper parts marked with `synthetic: true` are ignored.
