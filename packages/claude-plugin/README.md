# Memory Engine Claude Code Plugin

Captures your Claude Code conversations to [Memory Engine](https://memory.build) — every prompt you submit and every agent response becomes a searchable memory that persists across sessions. Also bundles the Memory Engine MCP server so your agent can search, create, and update memories directly from inside a session.

## Components

- **MCP server** (`me mcp`) — memory tools (search, create, get, update, delete, tree, import, export, etc.) available to the agent during sessions.
- **Hooks** — capture the session transcript as memories, one per message:
  - **Inert by default** — capture is opt-in. Turn it on machine-wide via the
    `me claude install` prompt, or per project with `capture: true` in the
    project's `.me/config.yaml` (a project can likewise opt *out* with
    `capture: false`). With capture off the hooks exit silently.
  - Once on, captures land **privately** under `~/projects/<slug>` (your own
    home tree) unless the project's `.me/config.yaml` pins a shared `tree`.
  - `Stop` fires after each turn and imports the session-so-far.
  - `SessionEnd` does a final import when the session closes.
  - This is the **same parse + write as `me … import`** (incremental: each fire
    only writes messages new since the last), so live captures and bulk imports
    land in the same place with the same metadata.
- **Async, best-effort**. Hooks never block your session; failures log to stderr and exit 0.

## Prerequisites

1. **`me` CLI** on PATH — required both for the MCP server and the hooks:

   ```bash
   curl -fsSL https://install.memory.build | sh
   ```

2. **Logged in** to a Memory Engine instance, with an active space selected:

   ```bash
   me login
   me space use <space>   # select the space to capture into
   me whoami              # confirms identity + active space
   ```

   That login session is all the plugin needs — `api_key` is **optional** (see below).

### Using a dedicated agent key (optional)

By default the plugin uses your `me login` session, so captures are attributed to **you**. To attribute captures to a separate, scoped-down **agent** identity instead — so it only touches the tree paths you allow — mint an api key and paste *that* into the plugin's `api_key`:

```bash
# 1. Create a dedicated agent
me agent create claude-code-agent

# 2. Add it to the space and grant just the access it needs — e.g. read+write on
#    the capture subtree (grants cover all descendant paths via ltree)
me agent add claude-code-agent
me access grant claude-code-agent share.projects w

# 3. Mint an API key for that agent
me apikey create --agent claude-code-agent plugin-key
# → prints the raw key once; paste it into the plugin's api_key config
```

See [Access control](https://docs.memory.build/access-control) for the full grant model.

## Install

The plugin is distributed through a Claude Code marketplace. Register the marketplace, install the plugin, then configure it from inside a Claude Code session.

```bash
# 1. Register the marketplace (one-time, user-global)
claude plugin marketplace add timescale/memory-engine

# 2. Install at the scope you want
claude plugin install memory-engine@memory-engine                   # user scope (all projects)
claude plugin install memory-engine@memory-engine --scope project   # committed to this repo
claude plugin install memory-engine@memory-engine --scope local     # this repo, gitignored
```

## Configure

Every value is optional if you're logged in with an active space — the plugin falls back to your `me login` session and `me space use` space. Claude Code does not prompt at install time; configure from inside a session.

```text
claude                               # start a session
/plugin                              # open the plugin manager
# → Installed → memory-engine → Configure
# → space       (OPTIONAL — blank = your active space; pin for project/shared installs)
# → api_key     (OPTIONAL, sensitive — blank = use your `me login` session)
# → server       (default https://api.memory.build)
# → content_mode (default | full_transcript — see below)
# → values take effect immediately; no restart required
```

Setting `api_key` marks a **headless** install: the operator deliberately
configured capture with a fixed key + space, so the hooks capture without the
per-user machine-wide opt-in (a project `.me/config.yaml` `capture: false`
still opts that project out).

Leave `api_key` blank to use your `me login` session (captures attributed to you); set it to use a dedicated agent key (see above). Leave `space` blank to capture into your active space; pin it for unattended or project-scope installs (a blank space with no active space set means captures are silently skipped). `content_mode` is `default` (user + assistant text — recommended) or `full_transcript` (also stores reasoning and tool calls/results as their own memories — more complete, but larger/noisier and may include sensitive tool output). Sensitive values (the api_key) go to your system keychain; non-sensitive values go to the `settings.json` for the scope you installed in.

## Verify

After a session (each turn's `Stop`, or `SessionEnd`), check that capture happened:

```bash
me memory search --tree '~/projects.*' --limit 5
```

Capture is the **same path as `me … import`** — one memory per message, with the
identical layout and metadata, so live and imported sessions interleave cleanly:

- **Tree**: the project's [`.me/config.yaml` `tree`](https://docs.memory.build/project-config) when set (`<tree>/agent_sessions` — e.g. `/share/projects/<slug>/agent_sessions` for a shared project), else the private `~/projects/<project>/agent_sessions` (your own home tree) — one node per project. There is no plugin-level tree setting: committed project config is the one routing surface.
- **Metadata**: the importer's `source_*` schema — `type: agent_session`, `source_tool: "claude"`, `source_session_id`, `source_message_id`, `source_message_role` (`user`/`assistant`), `source_project_slug` (from the git `origin` remote, else cwd basename), `content_mode`, `importer_version`, and (when available) `source_cwd` / `source_git_repo` / `source_model` / … See the full table in [agent session imports](https://docs.memory.build/cli/agent-session-imports).
- **Temporal**: each memory's `start` is the **message** timestamp.

## Multi-scope / multi-engine

Claude Code supports user/project/local scopes for both plugin installs and userConfig values. Different scopes store their own configuration; whichever scope is active for a session wins.

Example: a team wants everyone's Claude Code sessions *in their repo* to capture to a shared team engine, while each developer's user-scope install captures to their personal engine elsewhere.

```bash
# Each developer: personal engine for all projects
claude plugin install memory-engine@memory-engine --scope user
# → /plugin → Configure with personal api_key

# In the team's repo: project-scope install (settings.json is committed)
cd /path/to/team/repo
claude plugin install memory-engine@memory-engine --scope project
# → /plugin → Configure with a team-engine api_key
# note: api_key is sensitive — it stays in each developer's keychain, never committed
```

Inside the team repo, sessions capture to the team engine. Outside, they capture to the personal engine. Claude Code handles scope resolution per-session.

## Change API key / switch engine

Repeat the `/plugin → memory-engine → Configure` flow. Paste a new api_key. Values take effect immediately.

## Uninstall

```bash
claude plugin uninstall memory-engine@memory-engine                    # user scope
claude plugin uninstall memory-engine@memory-engine --scope project    # project scope
claude plugin marketplace remove memory-engine                         # optionally remove marketplace
```

Claude Code handles the cleanup. Your captured memories and API keys are preserved — delete them separately with `me memory` and `me apikey` commands if desired.

## Troubleshooting

**Hook fires but nothing is captured, no error**
Capture is **off by default** — the hooks exit silently until you opt in. Re-run `me claude install` and say yes at the capture prompt (or set `capture: true` in the project's `.me/config.yaml`). A project with `capture: false` is deliberately opted out.

**`[memory-engine] no credentials` in stderr**
The hook ran but found neither a `me login` session nor a configured api_key. Run `me login` (and `me space use <space>`), or open `/plugin → memory-engine → Configure` and set the api_key + space.

**Capture is on but no memories appear, no error**
With everything optional, a hook silently skips when it can't resolve a space — no `space` configured *and* no active space set (`me space use`). Either pin `space` in `/plugin → Configure` or run `me space use <space>`.

**Hook fires but no memories appear**
- Confirm the api_key is valid:
  ```bash
  ME_API_KEY="<the-key>" me memory tree --levels 1
  ```
- Run `claude --debug hooks` and look for `[memory-engine]` messages in stderr.
- Confirm `me` is on PATH from inside the Claude session: ask Claude to run `which me`.

**MCP server shows "failed" in `/plugin`**
Usually means there are no credentials to resolve: you're not logged in (`me login`) and no api_key is set, or `me` isn't on PATH. Fix it, then pick "Reconnect" from the plugin menu (or restart the session).
