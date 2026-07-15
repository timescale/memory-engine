# me claude

Claude Code integration commands.

## Commands

- [me claude install](#me-claude-install) -- install the Memory Engine plugin for Claude Code (full plugin by default, `--mcp-only` for just the MCP server)
- [me claude init](#me-claude-init) -- removed; use [`me project init`](me-project.md)
- [me claude env](#me-claude-env) -- internal helper (you never run this directly)
- [me claude hook](#me-claude-hook) -- internal helper the plugin uses to capture sessions (you never run this directly)
- [me claude import](#me-claude-import) -- import Claude Code sessions from `~/.claude/projects`

---

## me claude install

Install the **one, user-scoped** Memory Engine plugin for Claude Code — run it once and it applies to every project.

By default this installs the **full plugin** -- hooks (session capture, inert until you opt in), slash commands, and the MCP tools -- by driving Claude Code's native plugin CLI for you:

```
me claude install [options]
```

Under the hood it runs the equivalent of:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install --scope user memory-engine@memory-engine \
  [--config server=<url>] [--config space=<slug>] [--config api_key=<key>]
```

The marketplace step is idempotent (skipped if already configured). **By default nothing is pinned into the plugin** -- `server`, `space`, and `api_key` are left blank so the plugin (hooks + MCP) tracks your live `me` config at runtime: your `me login` server, active space, and session. Pinning is opt-in: `--server` / `--space` pin those, and `--api-key` marks a headless install (see below). After install, restart Claude Code (or run `/plugin`) to load the hooks and slash commands.

A session (non-headless) install then:

1. **Persists global defaults** into `~/.config/me` — the resolved server (`default_server`) and active space. The private `~/projects` tree root is a code default — install never writes it; to change it machine-wide, set [`tree_root`](../project-config.md#changing-the-default-tree-root-tree_root) in `~/.config/me/config.yaml` by hand.
2. **Provisions a default agent** (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)): no-op if a valid custom global `agent:` or `.user` opt-out is already set, or you're installing with `--api-key` (the key already IS an agent). Otherwise adopts your existing `coder` agent if you have one, or creates it with write access to your whole space, and writes it as the global `agent:` — so harness surfaces (MCP, hooks, a plain `me` call from Claude's own shell) have an agent to run as by default. If a configured global agent is stale, install prompts to create it interactively or fails clearly non-interactively. Skip with `--no-default-agent`.
3. **Asks whether to turn on session capture** (default **no** — the capture hook ships inert). Say **yes** and it enables the machine-wide `capture: true` and runs a one-time machine-wide [`me import claude`](me-import.md) backfill — everything lands **privately** under `~/projects/<slug>`, per project. Say no and you get the tools only. Re-run `me claude install` any time to change the answer; a project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) overrides per project either way. (Non-interactive runs skip the prompt and leave the setting untouched.)

Pass `--mcp-only` to skip the plugin and register just the `me` MCP server (no hooks, no slash commands).

| Option | Description |
|--------|-------------|
| `--mcp-only` | Register only the `me` MCP server (no hooks or slash commands). |
| `--api-key <key>` | API key for a headless agent. Default: the plugin/MCP server uses your `me login` session, resolved at runtime. |
| `--space <slug>` | Pin a space. Default: resolve `ME_SPACE` / active space at runtime. |
| `--server <url>` | Pin a server. Default: use your `me login` server at runtime. |
| `--dev` | Install the plugin from the local checkout instead of the published marketplace (run from inside this repo). |
| `--no-default-agent` | Skip provisioning the default agent (step 2 above). |

Credential handling: by default (a personal install) nothing is pinned, so the plugin (and the MCP server) uses your `me login` session, server, and active space, resolved from the OS keychain / `~/.config/me` at runtime — so it follows `me login` / `me space use` and survives re-login. Pass `--server` / `--space` to pin either. Pass `--api-key` (mint one with `me apikey create` for a personal access token, or `me apikey create --agent <agent>` for an agent) for a **headless** install that can't reach your keychain — since there's no session to fall back to, an api key bakes in a fixed server + space + key together (and skips the defaults/capture steps above — the operator's `~/.config/me` is not necessarily the agent's; capture is credential-agnostic, so a headless deployment opts in via a committed `.me` `capture: true` or `capture: true` in the target machine's config). The space is resolved from `--space`, `ME_SPACE`, or your active space (whichever is set — install errors if none, since a global key has no active space to fall back to at runtime), and `--server` defaults to your resolved server.

There is no `--scope` flag: the plugin is always installed at **user** scope (once, for all projects). Per-project behavior — a shared tree, a pinned space, a project agent, capture on/off — comes from the committed [`.me/config.yaml`](../project-config.md), which the single installed plugin reads per project.

For manual MCP client configuration, see [MCP Integration](../mcp-integration.md).

---

## me claude init

**Removed** — run [`me project init`](me-project.md), the harness-agnostic per-project setup wizard. The retired command prints an error and exits without running the wizard.

---

## me claude env

An internal helper the Memory Engine plugin runs automatically at the start of each Claude Code session. It's what makes a plain `me` call from Claude's Bash tool always resolve the right project (even after `cd`) and run as the agent configured in [`.me/config.yaml` or your global config](../project-config.md#agent-by-config-and-the-agent-field). **You never run this by hand** — it's installed by [`me claude install`](#me-claude-install).

---

## me claude hook

An internal helper the Memory Engine plugin runs automatically as a Claude Code session progresses. When session capture is on, it saves the conversation as memories, incrementally (each call only writes what's new). **You never run this by hand.**

**Inert unless capture is enabled**: capture resolves from the project's [`.me/config.yaml` `capture`](../project-config.md#the-capture-field-session-capture-onoff) → your machine-wide setting (the [`me claude install`](#me-claude-install) prompt) → off. With capture off, nothing is written. Once on, captures land privately under `~/projects/<slug>` unless the project's `.me` `tree` says otherwise.

The plugin (hooks, slash commands, and MCP) is installed by [`me claude install`](#me-claude-install), which drives Claude Code's native plugin flow for you. You can also run that flow by hand:

```bash
claude plugin marketplace add timescale/memory-engine
claude plugin install --scope user memory-engine@memory-engine
# then, in a Claude Code session:
/plugin  # select memory-engine, Configure (all values optional if logged in)
```

Both `api_key` and `space` are optional: blank `api_key` uses your `me login` session (set it to attribute captures to a dedicated agent), and blank `space` uses your active space (`me space use`; pin it for project/shared installs).

If you only want the MCP tools (no hooks, no slash commands), run [me claude install --mcp-only](#me-claude-install) instead.

Best-effort: logs failures to stderr but always exits 0 so that a hook failure never blocks a Claude Code session.

---

## me claude import

Import Claude Code sessions from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. This is an alias of [`me import claude`](me-import.md#me-import-claude--codex--opencode).

```
me claude import [options]
```

See [agent session imports](agent-session-imports.md) for the full option reference, tree layout, idempotency rules, content shape, and metadata schema.

**Default filters (off by default, opt in via flags):**

- Sidechain (`agent-*.jsonl`) files are skipped. These are subagent/Task spawns. Opt in with `--include-sidechains`.
- Sessions whose cwd is under `/tmp`, `/private/tmp`, `/private/var/folders`, or `/var/folders` are skipped. Opt in with `--include-temp-cwd`.
- Sessions with fewer than 2 user messages are skipped (one-shot queries, warm-up pings, and aborted sessions). Opt in with `--include-trivial`.

### Example

First-time import of Claude history for a specific project, as a dry run:

```bash
me claude import --project /Users/me/dev/memory-engine --dry-run --verbose
```
