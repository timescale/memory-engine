# me claude

Claude Code integration commands.

Two scopes, two commands:

- **`me claude install`** — set up the integration **for your user** (global,
  `~/.claude/`). Memory access runs as **you** (your `me login` session).
- **`me claude init`** — set up **this project** (`.claude/` + repo `.mcp.json`
  / `CLAUDE.md`). Memory access runs as the **project's agent** (the `agent` in
  `.me/config.yaml`), via the `X-Me-As-Agent` header.

## Commands

- [me claude install](#me-claude-install) -- user-scope setup (MCP + capture hooks + skill + `/memory-recall` + pointer)
- [me claude init](#me-claude-init) -- project-scope setup, acting as the project's `.me` agent (+ git history + backfills)
- [me claude hook](#me-claude-hook) -- invoked by the capture hooks (not run by hand)
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Set up the Claude Code integration for your user. Writes, under `~/.claude/`:
the MCP server (`claude mcp add --scope user`), capture hooks in
`settings.json`, the `memory-engine` skill, the `/memory-recall` command, and a
memory pointer in `~/.claude/CLAUDE.md`. Captures and tools run as **you**.

```
me claude install [options]
```

| Option | Description |
|--------|-------------|
| `--server <url>` | Pin a server into the MCP config (a pin implies a login session for that server). |
| `--space <slug>` | Pin a space into the MCP config. Implies `--server`. |
| `--remove` | Remove the user-scope integration. |

By default nothing is baked into the MCP config — `me mcp` resolves your
session + active space at runtime (so it survives `me login` / `me space use`).
Pin `--server`/`--space` to fix a global install to one target (see
[Project config](../project-config.md#precedence) for the precedence caveat).

---

## me claude init

Set up **this project**, acting as the project's agent. Requires a
`.me/config.yaml` with an `agent:` in scope (run the provisioning wizard first,
or add one by hand) — project scope *means* agent identity, so `init` fails
fast without it.

```
me claude init [options]
```

Runs a grouped, pre-checked set of steps (interactive picker in a TTY; otherwise
every step minus its `--skip-*` flag):

- **Import this project's existing Claude Code sessions** (one-time backfill)
- **Install capture hooks** in `.claude/settings.json` — new sessions captured going forward (with `env.ME_AS_AGENT=.me` so ad-hoc `me` calls in Claude's terminal also run as the agent)
- **Register the MCP server** — writes `.mcp.json` (`me --as-agent .me mcp`)
- **Install the `/memory-recall` command** and the **`memory-engine` skill**
- **Import git commit history** + **install a git post-commit hook** (both act as the agent)
- **Add a memory pointer to CLAUDE.md** — templated from `.me/config.yaml`; uses an `@AGENTS.md` import when the repo already carries the shared block

Every artifact is a managed block/file (idempotent re-runs; per-step `--skip-*`
flags). All the baked `me` invocations carry `--as-agent .me`, so the harness
acts as the project's agent (constrained to your own authorization).

---

## me claude hook

Invoked by the capture hooks in `settings.json` (reads the event JSON from
stdin) to import the session transcript — the same parse + write as
`me claude import`, incremental and idempotent. Not run by hand.

```
me claude hook --event <stop|session-end> [--scope <user|project>] [--full-transcript]
```

`--scope` records which install authored the hook so a user-scope hook defers
when a project-scope capture is also installed (avoiding double capture).
Best-effort: it logs on failure but always exits 0, so a capture never blocks a
Claude Code session.

---

## me claude import

Import Claude Code sessions from `~/.claude/projects`. Alias of
[`me import claude`](./me-import.md).
