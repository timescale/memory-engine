# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- register `me` as an MCP server with OpenCode, install the capture plugin + `/memory-recall` command + `memory-engine` skill
- [me opencode init](#me-opencode-init) -- **deprecated** alias of [`me project init`](me-project.md)
- [me opencode hook](#me-opencode-hook) -- invoked by the capture plugin to import a session (not run by hand)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/storage`

---

## me opencode install

Set up OpenCode: register `me` as an MCP server (editing `~/.config/opencode/opencode.json`), install the user-scope capture plugin (inert until you opt in) plus the `/memory-recall` command and the `memory-engine` skill, and ask whether to capture your OpenCode sessions — mirroring [`me claude install`](me-claude.md#me-claude-install)'s one-install model. This same flow is also what [`me project init`](me-project.md#preflight)'s preflight offers when it detects OpenCode installed but not yet set up.

```
me opencode install [options]
```

A session (non-headless) install provisions a default agent (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field); no-op if a global `agent:` is already set, or with `--api-key`; skip with `--no-default-agent`), then ends with the shared **capture prompt** (default **no**): say yes and it enables the machine-wide `capture: true` and runs a one-time machine-wide [`me import opencode`](me-import.md) backfill — everything lands privately under `~/projects/<slug>`. Say no and you get the tools only; the capture plugin stays inert. Re-run `me opencode install` to change the answer; a project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) overrides per project. A headless (`--api-key`) install skips the default agent + prompt — capture is credential-agnostic, so a headless deployment opts in via a committed `.me` `capture: true` or the target machine's config.

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

**Deprecated** — renamed to [`me project init`](me-project.md), the harness-agnostic per-project setup wizard. This alias prints a rename notice, runs the same command, and will be removed in a future release. See [`me project init`](me-project.md#3-setup-checklist) for the current (harness-gated) checklist steps.

The capture plugin (installed by [`me opencode install`](#me-opencode-install), not by `init`) shells out to `me opencode hook`, which reuses your `me login` session (or `ME_API_KEY` + `ME_SPACE`) -- no API key needs to be embedded in the plugin. The `me` CLI must be on `PATH` where OpenCode runs. Like the Claude hook, it is **inert unless capture is enabled** (project [`.me` `capture`](../project-config.md#the-capture-field-session-capture-onoff) → the machine-wide flag → off); the checklist's capture-enable step and the install prompt are the opt-in writers.

The same plugin also carries the **harness-agent environment contract** ([Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)): a `shell.env` hook injects `ME_PROJECT_DIR` (the session directory, so a `cd`'d Bash command still discovers the right project), `AI_AGENT=opencode`, and `ME_AS_AGENT=.me` into every shell command OpenCode runs, so a plain `me` call from OpenCode's own shell resolves and runs as the configured agent automatically — no manual env setup. If OpenCode itself was launched inside another session's live contract (a nested harness), the hook emits nothing rather than overwriting it.

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
| `--project-dir <dir>` | the session's project dir — anchors `.me/config.yaml` discovery; passed by the generated plugin |
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
