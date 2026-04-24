# Memory Engine Claude Code Plugin

Captures your Claude Code conversations to [Memory Engine](https://memory.build) — every prompt you submit and every agent response becomes a searchable memory that persists across sessions. Also bundles the Memory Engine MCP server so your agent can search, create, and update memories directly from inside a session.

## Components

- **MCP server** (`me mcp`) — memory tools (search, create, get, update, delete, tree, import, export, etc.) available to the agent during sessions.
- **Hooks**:
  - `UserPromptSubmit` captures your prompt as a memory.
  - `Stop` captures the agent's final response as a memory.
- **Async, best-effort**. Hooks never block your session; failures log to stderr and exit 0.

## Prerequisites

1. **`me` CLI** on PATH — required both for the MCP server and the hooks:

   ```bash
   curl -fsSL https://install.memory.build | sh
   ```

2. **Logged in** to a Memory Engine instance with an active engine:

   ```bash
   me login
   me whoami   # confirms identity + active engine
   ```

3. **An API key** for the plugin. When you `me login`, an admin key for your identity is issued automatically and stored in your local credentials — you can look it up with:

   ```bash
   # inspect your credentials file (contains the key for the active engine)
   cat ~/.config/me/credentials.yaml
   ```

   To paste that key into the plugin is the simplest path.

### Restricting the plugin's privileges (optional but recommended)

The key you configure for the plugin does **not** have to be your admin key. You can issue a separate, scoped-down key and paste *that* into the plugin, so the agent only has access to the tree paths you want it to touch:

```bash
# 1. Create a dedicated engine user for the agent
me user create claude-code-agent

# 2. Grant it just the access it needs — in this example, read+create on
#    the capture subtree (grants cover all descendant paths via ltree)
me grant create claude-code-agent claude_code.sessions read create

# 3. Issue an API key for that user
me apikey create claude-code-agent plugin-key
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

The plugin needs three values: `api_key`, `server`, and `tree_prefix`. Claude Code does not prompt for them at install time — you configure them from inside a session.

```text
claude                               # start a session
/plugin                              # open the plugin manager
# → Installed → memory-engine → Configure
# → api_key     (sensitive — stored in keychain)
# → server      (default https://api.memory.build)
# → tree_prefix (default claude_code.sessions)
# → values take effect immediately; no restart required
```

Sensitive values (the api_key) go to your system keychain. Non-sensitive values go to the `settings.json` for the scope you installed in.

## Verify

After configuring, send a prompt in Claude Code, then check that capture happened:

```bash
me memory search --tree "claude_code.*" --limit 5
```

You should see your recent prompts (and, after the agent finishes, its response). What gets stored:

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

**`[memory-engine] CLAUDE_PLUGIN_OPTION_API_KEY not set` in stderr**
The hook ran but userConfig isn't filled in. Open `/plugin → memory-engine → Configure` and set the api_key.

**`Plugin option "X" isn't set` in Claude Code's error panel**
A required userConfig value is missing for either a hook or the MCP server. Configure all three: api_key, server, tree_prefix.

**Hook fires but no memories appear**
- Confirm the api_key is valid:
  ```bash
  ME_API_KEY="<the-key>" me memory tree --levels 1
  ```
- Run `claude --debug hooks` and look for `[memory-engine]` messages in stderr.
- Confirm `me` is on PATH from inside the Claude session: ask Claude to run `which me`.

**MCP server shows "failed" in `/plugin`**
Usually means api_key or server is missing from userConfig. Fix the configuration, then pick "Reconnect" from the plugin menu (or restart the session).
