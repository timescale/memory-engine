# Memory Engine Claude Code Plugin

Automatically captures your coding agent conversations to [Memory Engine](https://memory.build) -- every prompt you send and every response you receive becomes a searchable memory, persisted across sessions.

This is an early PoC. It captures the conversational layer (what you asked, what the agent concluded) but does not yet load context at session start or provide slash commands. The goal is to build a corpus of session data and learn what's useful before adding retrieval features.

## How It Works

The plugin registers three Claude Code hooks:

| Hook | Event | What Happens |
|------|-------|-------------|
| **SessionStart** | Session begins | Checks that `me` CLI is on PATH and can reach the engine. Warns on stderr if not (does not block). |
| **UserPromptSubmit** | You send a prompt | Captures your prompt text as a memory. Runs async (does not delay your session). |
| **Stop** | Agent finishes responding | Captures the agent's final response as a memory. Runs async. Skips empty responses. |

The plugin also bundles the Memory Engine MCP server (`.mcp.json`), which gives the agent access to all ME tools -- search, create, update, delete, import, export, tree, and move.

### Capture Flow

```
Claude Code fires hook event (JSON on stdin)
  |
  v
Bun script parses JSON, extracts content
  |
  v
Shells out to: me memory create --tree ... --meta ... --temporal ...
  (content piped via stdin to avoid escaping issues)
  |
  v
`me` CLI handles authentication and calls the Memory Engine API
```

All captures are **best-effort**: if the ME API is unreachable (offline, wrong credentials, engine down), the hook logs a one-line warning to stderr and exits cleanly. Your Claude Code session is never blocked or interrupted by a capture failure.

### What Gets Stored

Each captured memory includes:

**Content**: The raw text of your prompt or the agent's response. No transformation, no summarization, no extraction.

**Tree path**: `poc.claude_code.sessions` (all captures share one flat tree path for now).

**Metadata**:
```json
{
  "type": "user_prompt",
  "session_id": "1866e6ae-1f67-40c2-a3d1-830f24608de7",
  "project": "memory_engine",
  "cwd": "/Users/you/projects/your-repo",
  "source": "claude-code",
  "plugin_version": "0.0.1"
}
```

- `type`: `"user_prompt"` or `"agent_response"`
- `session_id`: Claude Code's session UUID (stable within a session, groups related memories)
- `project`: derived from git remote origin URL (e.g., `https://github.com/org/repo` becomes `repo`). Falls back to the working directory name if no git remote is found. Sanitized for ltree (lowercase, underscores only).
- `cwd`: the working directory when the hook fired
- `source`: always `"claude-code"`
- `plugin_version`: tracks which version of the plugin created the memory

**Temporal**: ISO 8601 timestamp of when the hook received the event (point-in-time). Enables temporal search ("what did we discuss this morning?").

### What Does NOT Get Stored

- **Tool calls** (Read, Edit, Bash, etc.): These are execution details -- the *how*. They're noisy, often huge (full file contents), and re-derivable. The agent will re-read files and re-run commands as needed.
- **Compaction summaries**: Claude generates these during context compression. Useful but deferred to a later version.
- **Individual turns during streaming**: We capture the final response, not intermediate tokens.

## Prerequisites

1. **Memory Engine CLI** (`me`) installed and on PATH.
   ```bash
   curl -sSfL https://install.memory.build | sh
   ```

2. **Logged in** to a Memory Engine instance:
   ```bash
   me login
   ```
   Or set environment variables: `ME_API_KEY` and `ME_SERVER`.

3. **Bun** runtime installed (the hook scripts are TypeScript executed with Bun):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

## Install

From a local checkout of this repo:

```
/plugin marketplace add /absolute/path/to/this/repo
/plugin install memory-engine@memory-engine
/reload-plugins
```

From the git remote (once pushed):

```
/plugin marketplace add timescale/memory-engine
/plugin install memory-engine@memory-engine
/reload-plugins
```

You should see "Checking Memory Engine environment..." briefly on session start.

## Verify It's Working

After sending a few prompts in Claude Code, open another terminal and run:

```bash
me memory search --tree "poc.claude_code.*" --limit 10
```

You should see your recent prompts and agent responses listed with their tree path and content preview.

To see full details on a specific memory:

```bash
me memory get <memory-id>
```

## Searching Your Captured Sessions

Once you have captured data, you can search it:

```bash
# Semantic search across all captured sessions
me memory search --semantic "auth module refactor" --tree "poc.claude_code.*"

# Find everything from a specific session
me memory search --meta '{"session_id": "1866e6ae-..."}' --tree "poc.claude_code.*"

# Find what you discussed today
me memory search --tree "poc.claude_code.*" --temporal-contains "2026-04-22"

# Full-text keyword search
me memory search --fulltext "JWT token" --tree "poc.claude_code.*"
```

The agent can also search using the bundled MCP tools (`me_memory_search`, `me_memory_get`, etc.) during your session.

## Known Limitations

- **Bun required**: The hook scripts are TypeScript executed via `bun`. Users without Bun installed will see hook errors. A future version may ship compiled JavaScript.
- **No context loading at session start**: The plugin captures but does not yet inject past context into new sessions. The agent can manually search ME using the MCP tools.
- **No slash commands**: No `/remember`, `/recall`, or similar commands yet. Use the MCP tools directly or the `me` CLI.
- **Flat tree path**: All captures go to `poc.claude_code.sessions` regardless of project. Session identity is in the metadata, not the tree structure. This may change.
- **Engine identity**: The plugin's hooks use whatever engine `me` is logged into (via `me login` or env vars). The bundled MCP server also runs `me mcp`, which uses the same credentials. If you switch engines with `me login` mid-session, new captures go to the new engine but the MCP server may still be connected to the old one until you restart.
- **macOS / Linux only**: Not tested on Windows.
- **Async capture**: Hooks run with `"async": true`, meaning captures happen in the background. In rare cases, a very fast session exit could drop the last capture if the process hasn't finished.

## Troubleshooting

**No memories appearing after prompts:**
1. Check that `me` is on PATH: `which me`
2. Check that you're logged in: `me whoami`
3. Try creating a memory manually: `echo "test" | me memory create --tree poc.test`
4. Check Claude Code's debug output: `claude --debug` and look for `[memory-engine]` prefixed messages in stderr

**"me CLI not found" warning on session start:**
Install `me`: `curl -sSfL https://install.memory.build | sh`

**Captures going to the wrong engine:**
Run `me whoami` to see which engine you're connected to. Use `me login` to switch if needed, then restart Claude Code (or `/reload-plugins`).

## Plugin Structure

```
packages/claude-plugin/
├── .claude-plugin/
│   └── plugin.json           # plugin manifest (name, version, description)
├── hooks/
│   └── hooks.json            # hook configuration (SessionStart, UserPromptSubmit, Stop)
├── scripts/
│   ├── check-env.ts          # SessionStart: verify me CLI and engine connectivity
│   ├── capture-prompt.ts     # UserPromptSubmit: save user prompt to ME
│   └── capture-response.ts   # Stop: save agent final response to ME
├── .mcp.json                 # bundles the Memory Engine MCP server
└── README.md                 # this file
```

The marketplace entry lives at the repo root: `.claude-plugin/marketplace.json`.

## Uninstall

```
/plugin uninstall memory-engine@memory-engine
/plugin marketplace remove memory-engine
```

To clean up captured PoC data:

```bash
# See what's there
me memory search --tree "poc.claude_code.*" --limit 100

# Delete via MCP or CLI (no bulk delete-tree CLI command yet)
# Use the MCP tool: me_memory_delete_tree with tree "poc.claude_code"
```
