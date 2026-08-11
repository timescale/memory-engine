---
title: Claude Code Harness Adapter
tags: [harnesses, claude, mcp, capture]
---

# Claude Code Harness Adapter

The Claude adapter is a user-scoped Memory Engine plugin installed through the
Memory Engine marketplace. The plugin provides the managed MCP registration and
the hooks needed for the shared harness contract and optional capture.

## Session environment

The plugin's `SessionStart` hook runs `me claude env`. The hook reads Claude's
session `cwd` from its event payload and writes `AI_AGENT=claude` plus
`ME_PROJECT_DIR` into Claude's sourced environment file. The write is
marker-delimited and idempotent because SessionStart can run again on resume or
after a session reset.

This is an environment-discovery mechanism only. It does not select credentials,
enable MCP, or enable capture.

## MCP and capture

The plugin starts the managed MCP process, which resolves the Claude MCP policy
for the session directory. Claude's project-directory environment can be used as
a fallback for managed MCP discovery, but an existing directory profile at the
process working directory takes precedence to avoid worktree ambiguity.

The plugin's `Stop` and `SessionEnd` hooks invoke `me claude hook`. Each hook
reads the transcript path and resolves capture policy from the session directory.
Capture runs asynchronously and exits successfully on errors so it cannot block
Claude's session lifecycle.

## Installation boundary

Installation registers the marketplace and plugin at user scope. Restarting
Claude Code loads changed plugin assets. Policy remains external to the plugin,
so one installation can be active in some directories and dormant in others.
