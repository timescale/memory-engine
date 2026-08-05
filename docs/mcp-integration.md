# MCP Integration

Memory Engine connects AI agents to persistent memory through the [Model Context
Protocol](https://modelcontextprotocol.io/) (MCP). An MCP client starts `me mcp`
as a local stdio process; that process sends authenticated requests to Memory
Engine on the agent's behalf.

```text
AI coding agent <-> me mcp (stdio) <-> Memory Engine (HTTPS)
```

The agent calls tools. It does not need to handle a Memory Engine credential
directly.

## Managed Harness Setup

For Claude Code, OpenCode, or Codex CLI, use the managed integration path:

```bash
me init
```

Run it from the repository you want to configure. It enables MCP for detected
harnesses and offers to install any missing integrations. Managed integrations
are user-global, but MCP availability is controlled by the machine-local profile
that applies to the harness directory.

If the matched profile disables MCP or does not select the harness, its managed
MCP process starts without Memory Engine tools. Use `me doctor --harness <name>`
to inspect the effective policy.

Installation and policy configuration are separate operations. See [Harness
Integrations](harness-integrations.md) for the lifecycle, provider-specific
requirements, and `~/.config/me/config.yaml`.

## Authentication

`me mcp` authenticates in this order:

1. `--api-key <key>`
2. `ME_API_KEY`
3. Your stored `me login` session

A local developer installation normally uses the stored session. For a
headless, unattended, or least-privilege environment, use a personal access
token or service-account key through `ME_API_KEY`. Memory Engine never persists
API keys for you.

The server URL resolves from `--server`, then `ME_SERVER`, then the saved
default server, then `https://api.memory.build`.

## Space Modes

An explicit `--space` or `ME_SPACE` creates a **locked** MCP server. Its memory
tools use that one space and do not expose a `space` parameter.

Without either selector, manual `me mcp` starts in **multi-space** mode.
`me_space_list` is available and memory tools require a `space` argument. A
stored active space does not lock a manual MCP server.

Selecting a space never grants access. Every operation remains constrained by
the authenticated principal's membership and tree grants.

## Manual Stdio Setup

Any MCP client that supports stdio can start Memory Engine directly:

```bash
me mcp
```

Give the client a Memory Engine session through its normal process environment,
or allow it to forward `ME_API_KEY`, `ME_SERVER`, and optionally `ME_SPACE`.
For example, a client configuration can launch `me mcp` and allowlist those
environment variable names rather than storing a raw key in its config file.

Use a locked manual server only when every request should stay in one space:

```bash
me mcp --space <space-slug>
```

For multi-space use, call `me_space_list` first and pass the returned slug to
each memory tool.

## Provider Notes

### Claude Code

Install with `me claude install`, then restart Claude Code. The managed plugin
supplies MCP and capture plumbing; `me init` decides when they are active.

### OpenCode

Install with `me opencode install`, then restart OpenCode. It writes a managed
MCP entry and generated plugin without credentials or runtime targeting.

### Codex CLI

Install with `me codex install`, then approve the installed hooks through
`/hooks`. Codex forwards `ME_API_KEY`, `ME_SERVER`, and `ME_SPACE` to the
managed MCP process when they exist in Codex's environment. Restart Codex after
changing those variables.

See [`me claude`](cli/me-claude.md), [`me opencode`](cli/me-opencode.md), and
[`me codex`](cli/me-codex.md) for provider details.

## Available Tools

Once connected, an agent can inspect its context, store and search memories,
manage trees, and import or export records. See the [MCP Tool Reference](mcp/index.md)
for every tool and [MCP Agent Instructions](mcp/agent-instructions.md) for
recommended agent behavior.

## Troubleshooting

1. Confirm `me` is on the MCP client's `PATH`.
2. Run `me status` to check local credentials.
3. Run `me doctor --harness <name>` for a managed integration.
4. Restart the harness after changing its installation or environment.
5. For Codex, confirm its hooks are approved through `/hooks`.
