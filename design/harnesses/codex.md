---
title: Codex CLI Harness Adapter
tags: [harnesses, codex, mcp, capture, hooks]
---

# Codex CLI Harness Adapter

The Codex adapter installs a user-global managed MCP registration and hooks in
Codex's hook configuration. It also allows non-secret `ME_API_KEY`, `ME_SERVER`,
and `ME_SPACE` environment variables to reach the managed MCP process without
writing their values into Codex configuration.

## Session environment

Codex does not expose a shell-environment hook. Its `PreToolUse` hook may rewrite
a Bash tool command, so `me codex env-hook` reads the hook payload and prepends a
shell-quoted export of `AI_AGENT=codex` and the payload's `cwd` as
`ME_PROJECT_DIR`.

The rewrite is deliberately narrow and fail-open. Non-Bash calls are ignored. An
unrecognized payload produces no rewrite and records only a sanitized payload
shape for `me doctor`; it never logs command content or blocks a Codex turn.

## MCP and capture

The managed MCP registration runs `me mcp --harness codex` and is gated by the
Codex MCP policy. `Stop` and `SessionEnd` hooks invoke `me codex hook`, which
imports the supplied transcript only when capture policy selects Codex. Capture
is best-effort and always exits successfully.

## Provider constraint

Codex requires the user to approve hooks through `/hooks`. Installation cannot
and must not bypass that provider trust decision. This also prevents a safe,
fully non-interactive live smoke test of Codex hook installation.
