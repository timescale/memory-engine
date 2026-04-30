---
name: use-memory
description: "Bind this Claude Code session to a specific Memory Engine (or list, switch, provision). Use when the user asks to switch engines, route memory writes to a team-shared engine, set up a new engine in the current session, or runs /use-memory. Not for creating, searching, or editing individual memories (use the me_memory_* tools directly)."
---

# Use Memory Engine

Pick which Memory Engine this session reads from and writes to. Wraps three MCP tools: `me_engine_list`, `me_session_use_engine`, and `me_session_provision_engine`.

This skill changes ONLY the in-process binding for the current Claude Code session. It does not affect other sessions, other MCP clients, or the active engine the next `me` CLI invocation uses.

## When to use

- The user types `/use-memory <engine>` (or `/memory-engine:use-memory <engine>`).
- The user asks to "switch to <engine>", "use the <team> engine", "route memories to <engine>", etc.
- A workflow needs to scope writes to a team-shared knowledge base before recording findings.
- The user asks "which engine am I using?" — answer with `me_session_get_engine` (no argument needed).

## Inputs

The user invocation takes one optional positional argument: an engine slug, name, or ID. Examples:

- `/use-memory team-connectors-oncall`
- `/use-memory "Team On-call"`
- `/use-memory` (no argument — pick interactively)

If the user passes nothing, run `me_engine_list` first and present the list with `AskUserQuestion`. If the user passes an ambiguous name (engine exists in multiple orgs), `me_session_use_engine` errors with the disambiguation candidates; surface those choices via `AskUserQuestion` rather than guessing.

## Workflow

1. **Resolve the target engine.**
   - If the user gave an argument, skip to step 2 with `engine: <arg>`.
   - Otherwise call `me_engine_list` and present the engines with `AskUserQuestion`. Prefer engines where `has_local_key: true` (no provisioning round-trip needed) but list all of them.

2. **Try to bind.** Call `me_session_use_engine({ engine: <slug-or-name> })`.
   - On success, confirm to the user: `Bound this session to <name> (<orgName>). Previous: <previous_engine | "FRESH">.` Stop.
   - If the error message contains `Ambiguous engine`, parse the candidate `<orgSlug>:<slug>` pairs from the error, present them with `AskUserQuestion`, then retry with `org: <chosen-orgSlug>`.
   - If the error message contains `No local API key for engine '<slug>'`, go to step 3.
   - If the error message contains `No engine matches`, tell the user the slug doesn't exist and offer `me_engine_list` (or a filtered list if you have one).

3. **Provision an API key in-session.** Call `me_session_provision_engine({ engine: <slug> })`.
   - This calls `setupAccess` against the server using the user's session token, writes the new key under `engines.<slug>.api_key` in `~/.config/me/credentials.yaml`, and binds the session.
   - On success, confirm: `Provisioned key and bound this session to <name> (<orgName>).` Stop.
   - Failures from `setupAccess` (org membership, deleted engine, etc.) come through unchanged. Surface them; do not retry blindly.

4. **Verify (optional).** If the user wants reassurance, call `me_session_get_engine` and echo the result.

## Critical rules

- **Never** prompt the user to run `me engine use <slug>` outside Claude Code. That advice predates `me_session_provision_engine`. Always provision in-session.
- **Never** call `me_memory_*` tools to "test" the binding before confirming success — `me_session_use_engine` already validates by default (it round-trips `me_memory_tree({ levels: 1 })` against the new key).
- Do not log or echo raw API keys. The MCP server writes the key directly to disk; the agent should never see it. If a tool result accidentally includes a `rawKey` field, drop it before responding.
- After provisioning, the new key persists in `credentials.yaml` and is reusable across sessions. The session binding is in-memory and resets when Claude Code closes.

## Error recovery patterns

| Error | Action |
|-------|--------|
| `Not logged in: no session token...` | Tell the user to run `me login` outside the agent. Stop; do not retry. |
| `Ambiguous engine '<arg>'. Matches: a:<slug>, b:<slug>...` | Parse candidates, `AskUserQuestion`, retry with `org`. |
| `No engine matches '<arg>'` | Call `me_engine_list`, present results, ask which one. |
| `No local API key for engine '<slug>'` | Call `me_session_provision_engine` with the same slug. |
| Server-side `setupAccess` failure | Surface verbatim. The user may not be a member of the engine's org. |

## Output format

Keep confirmations short. One line is plenty:

```
Bound this session to Team On-call (Tiger Data). Previous: personal-gonzalo.
```

```
Provisioned key and bound this session to Team On-call (Tiger Data).
```

If the user asked "which engine?", respond with the engine name and slug, plus FRESH if unbound. No JSON.
