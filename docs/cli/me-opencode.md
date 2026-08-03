# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- install the dormant Memory Engine MCP registration
- [me opencode uninstall](#me-opencode-uninstall) -- remove the recorded MCP registration
- [me opencode init](#me-opencode-init) -- removed; use [`me project init`](me-project.md)
- [me opencode hook](#me-opencode-hook) -- internal helper (you never run this directly)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/opencode.db` or legacy storage

---

## me opencode install

Install OpenCode's dormant user-global integration:

```bash
me opencode install
```

This non-interactive command writes the user-global `mcp.me` entry with the
exact command `["me", "mcp"]` and installs a dormant capture/shell plugin
under `~/.config/opencode/plugins/`. It does not write project files, prompt,
pin credentials or runtime targeting, install recall commands or skills, or
backfill sessions.

The plugin captures only when the local OpenCode `capture` profile selected for
the session directory enables OpenCode. Its shell hook injects only
`AI_AGENT=opencode` and `ME_PROJECT_DIR`.

OpenCode's MCP child working-directory behavior still requires manual
validation. Until then, routing falls back to the shared defaults behavior when
no provider context is available.

## me opencode uninstall

```bash
me opencode uninstall
```

Removes only recorded, unchanged artifacts. It deletes `mcp.me` while preserving
unrelated OpenCode configuration, and removes the `mcp` object when it becomes
empty. A modified generated plugin is retained.

---

## me opencode init

**Removed** — run [`me project init`](me-project.md), the harness-agnostic per-project setup wizard. The retired command prints an error and exits without running the wizard.

---

## me opencode hook

An internal helper the OpenCode plugin runs automatically as a session progresses. It resolves the local capture profile from the OpenCode session directory and exits successfully when no selected OpenCode capture profile exists. When selected, it imports the session via the same incremental path as `me import opencode`. **You never run this by hand** — it is best-effort and never blocks an OpenCode session.

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
