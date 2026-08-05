# me opencode

OpenCode integration commands.

## Commands

- [me opencode install](#me-opencode-install) -- install dormant Memory Engine plumbing
- [me opencode uninstall](#me-opencode-uninstall) -- remove recorded Memory Engine plumbing
- [me opencode hook](#me-opencode-hook) -- internal helper (you never run this directly)
- [me opencode import](#me-opencode-import) -- import OpenCode sessions from `~/.local/share/opencode/opencode.db` or legacy storage

---

## me opencode install

Install OpenCode's dormant user-scoped integration:

```bash
me opencode install
```

This non-interactive command writes a managed MCP entry and installs the
generated dormant plugin. The plugin only supplies the shell contract and
capture plumbing; it does not install commands, skills, credentials, or static
runtime targeting.

## me opencode uninstall

```bash
me opencode uninstall
```

Removes only recorded MCP/plugin artifacts when they remain unchanged.

Turning capture on (and pointing it at a server/space/tree) is a separate,
machine-local step — see [`me init`](me-init.md).

See [Harness Integrations](../harness-integrations.md) for the managed
installation lifecycle and policy model.

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
