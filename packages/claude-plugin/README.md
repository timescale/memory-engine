# Memory Engine Claude Code Plugin

Captures user prompts and agent responses to [Memory Engine](https://memory.build) for persistent context across coding sessions.

## Prerequisites

- [Memory Engine CLI](https://memory.build/install) (`me`) installed and on PATH
- `me login` completed, or `ME_API_KEY` / `ME_SERVER` environment variables set
- [Bun](https://bun.sh) runtime installed

## Install

Add the marketplace and install the plugin:

```
/plugin marketplace add timescale/memory-engine
/plugin install memory-engine@memory-engine
```

Or from a local checkout:

```
/plugin marketplace add /path/to/me0
/plugin install memory-engine@memory-engine
```

Then reload:

```
/reload-plugins
```

## What It Does

- **UserPromptSubmit**: Saves every user prompt to Memory Engine
- **Stop**: Saves every agent final response to Memory Engine
- **SessionStart**: Verifies `me` CLI is available

Memories are stored at tree path `poc.claude_code.sessions` with metadata including session ID, project name, and timestamp.

The plugin also bundles the Memory Engine MCP server, giving the agent access to search, create, update, and delete memories.

## Verify

After a few prompts, check that memories are being captured:

```bash
me memory search --tree "poc.claude_code.*" --limit 5
```

## Uninstall

```
/plugin uninstall memory-engine@memory-engine
/plugin marketplace remove memory-engine
```
