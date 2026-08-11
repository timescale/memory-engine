---
title: OpenCode Harness Adapter
tags: [harnesses, opencode, mcp, capture]
---

# OpenCode Harness Adapter

The OpenCode adapter installs two user-global artifacts: a local managed MCP
entry and a generated Memory Engine plugin. The MCP entry runs
`me mcp --harness opencode`; the plugin supplies runtime environment and capture
hooks.

## Session environment

OpenCode exposes a `shell.env` plugin hook. The generated plugin sets
`AI_AGENT=opencode` and `ME_PROJECT_DIR` to OpenCode's session directory on every
harness shell command. No command rewriting is needed.

## MCP and capture

The managed MCP entry is dormant until the matching MCP policy enables OpenCode.
The generated plugin listens for `session.idle` and `session.deleted`, then calls
`me opencode hook` with the session ID and project directory. That command loads
the session from OpenCode storage and imports it only when capture policy selects
OpenCode.

The plugin awaits the capture attempt but swallows failures. Session capture is
therefore idempotent and best-effort rather than a condition for OpenCode to
continue.

## Installation boundary

The installer changes only its named MCP entry and generated plugin file. It
refuses to claim an unrecorded or user-modified artifact, and uninstall preserves
such artifacts for manual review.
