# Memory Engine Claude Code Plugin

Captures your Claude Code conversations to [Memory Engine](https://memory.build) — every prompt you submit and every agent response becomes a searchable memory that persists across sessions. Also bundles the Memory Engine MCP server so your agent can search, create, and update memories directly from inside a session.

## Components

- **MCP server** (`me mcp`) — 20+ tools for searching, creating, updating, and organizing memories.
- **Hooks**:
  - `UserPromptSubmit` captures your prompt as a memory.
  - `Stop` captures the agent's final response as a memory.
- **Async, best-effort**. Hooks never block your session; failures log to stderr and exit 0.

## Prerequisites

1. **`me` CLI** on PATH (required both for the MCP server and the hooks):

   ```bash
   # Install however you normally install; e.g.:
   brew install timescale/tap/me     # (future)
   npm install -g @memory.build/cli  # (future)
   ```

2. **An API key** with access to the engine you want to capture to. Create one with:

   ```bash
   me apikey create --engine <engine-slug>
   ```

   **Tip**: the key you configure for the plugin does NOT have to match the identity you use for `me login`. You can issue a separate, scoped-down key (e.g., a service-account key limited to the capture tree) and paste that into the plugin. See [Access control](https://docs.memory.build/access-control) for details.

## Install

The plugin is distributed through a Claude Code marketplace. Register the marketplace, then install the plugin, then configure it from inside a Claude Code session.

```bash
# 1. Register the marketplace (one-time, user-global)
claude plugin marketplace add timescale/memory-engine

# 2. Install the plugin at the scope you want
claude plugin install memory-engine@memory-engine                   # user scope (all projects)
claude plugin install memory-engine@memory-engine --scope project   # commit to this repo
claude plugin install memory-engine@memory-engine --scope local     # this repo, gitignored
```

## Configure

The plugin needs three values: `api_key`, `server`, and `tree_prefix`. Claude Code does not prompt for these at install time — you configure them from inside a session.

```
claude                               # start a session
/plugin                              # open the plugin manager
# → Installed → memory-engine → Configure
# → fill in api_key (sensitive), server (default ok), tree_prefix (default ok)
# → confirm; the plugin picks up the new values immediately
```

Sensitive values (like `api_key`) go to the system keychain. Non-sensitive values go to the settings.json for the scope you installed in.

## Verify

After you've configured the plugin, send a prompt in Claude Code, then check that capture happened:

```bash
me memory search --tree "claude_code.*" --limit 5
```

You should see your recent prompts (and, after the agent finishes, its response). Tree path and metadata reflect what you configured:

- **Tree**: whatever you set in `tree_prefix` (default: `claude_code.sessions`)
- **Metadata**:
  - `type`: `user_prompt` or `agent_response`
  - `session_id`: Claude Code's session UUID
  - `project`: derived from `git remote get-url origin` in the session cwd (falls back to cwd basename)
  - `cwd`: working directory when the hook fired
  - `source`: `"claude-code"`
  - `me_version`: the `me` CLI version that created the memory
- **Temporal**: ISO timestamp of hook invocation

## Multi-scope / multi-engine

Claude Code supports user/project/local scopes for plugin installs and userConfig values. Different scopes store their own configuration; whichever scope is active for your session wins.

Example: a team wants everyone's Claude Code sessions on their repo to capture to a shared team engine, while each developer's user-scope install captures to their personal engine.

```bash
# each developer: personal engine for all their projects
claude plugin install memory-engine@memory-engine --scope user
# → configure with personal api_key

# in the team's repo: project-scope install (settings.json is committed)
cd /path/to/team/repo
claude plugin install memory-engine@memory-engine --scope project
# → /plugin → configure with a team-engine api_key
# note: api_key is sensitive — stays in each developer's keychain, not committed
```

Inside the team repo, sessions capture to the team engine. Outside, they capture to the personal engine. Claude Code handles the scope resolution.

## Change API key / switch engine

Repeat the `/plugin → Configure` flow. Paste a new api_key. Values take effect immediately — no restart required.

## Uninstall

```bash
claude plugin uninstall memory-engine@memory-engine                    # user scope
claude plugin uninstall memory-engine@memory-engine --scope project    # project scope
claude plugin marketplace remove memory-engine                         # optionally remove marketplace
```

Claude Code handles the cleanup. Your captured memories and API keys are preserved — delete them separately with `me memory` and `me apikey` commands if desired.

## Troubleshooting

**"Configure the plugin via `/plugin` in Claude Code" in stderr**
The hook ran but `CLAUDE_PLUGIN_OPTION_API_KEY` isn't set. Configure via `/plugin → memory-engine → Configure`.

**"Plugin option 'X' isn't set" in Claude Code's error panel**
A required userConfig value is missing for either a hook or the MCP server. Configure all three: api_key, server, tree_prefix.

**Hook fires but no memories appear**
- Confirm the api_key is valid: `me memory tree --levels 1` with the same key
- Check `claude --debug` output for `[memory-engine]` messages
- Confirm `me` is on PATH from inside the Claude session: ask Claude to run `which me`

**MCP server shows "failed" in `/plugin`**
Usually means the api_key or server config is missing. Fix the userConfig then pick "Reconnect" from the plugin menu, or restart the session.
