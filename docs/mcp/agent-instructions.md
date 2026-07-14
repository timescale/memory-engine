# MCP Agent Instructions

This page is for AI agents that already have Memory Engine MCP tools available.
It explains how to use memory during work. For setup, see
[MCP Integration](../mcp-integration.md).

## Use Memory Proactively

- Search memory before nontrivial work to find prior decisions, project context,
  conventions, and known issues.
- Search again when making a design choice, changing behavior, debugging a
  surprising failure, or touching an unfamiliar subsystem.
- Store durable knowledge after you learn something that should help a future
  session: decisions, project conventions, runbooks, important tradeoffs,
  workarounds, and non-obvious debugging results.
- Do not store secrets, credentials, private keys, tokens, or short-lived chatter.

## Search Deliberately

Use `me_memory_search` with the search mode that matches the task:

- Use `semantic` for concepts, intent, and natural-language questions.
- Use `fulltext` for exact words, identifiers, command names, file names, error
  strings, and other literal text.
- Use both `semantic` and `fulltext` only when both meaning and exact terms are
  useful for the same query.
- Use `tree`, `meta`, `temporal`, and `grep` filters to narrow results when you
  know the relevant area or attribute.
- Use `me_memory_tree` to inspect visible tree structure and counts before
  browsing or choosing a tree.

Example semantic search:

```json
{
  "semantic": "how do we handle OAuth token rotation",
  "limit": 10
}
```

Example exact search:

```json
{
  "fulltext": "X-Me-As-Agent",
  "limit": 10
}
```

Example filtered browse:

```json
{
  "tree": "/share/design/*",
  "limit": 20,
  "order_by": "desc"
}
```

## Understand Access

Each MCP server runs in one active space as one authenticated principal: a user,
agent, or service account. What you can see or change depends on that principal's
tree-access grants in the active space.

Access is path-based and hierarchical:

- `read` lets you search and retrieve memories at or below a path.
- `write` lets you read plus create, update, move, and delete memories.
- `owner` lets you write plus manage access under that path.

Access filtering is quiet. If you lack `read` on a memory's tree path, search may
return fewer results and retrieval may report `not found`. If you lack `write`,
creating or changing a memory in that tree fails even if the tree exists.

Call `me_memory_context` when you need to confirm the current space, acting
principal, or effective tree-access grants. The access list shows the paths you
can actually read, write, or own, including inherited group access and agent
owner-clamping.

Do not assume every space has the same layout or grants. Some spaces use
`/share/...` for team knowledge and `~/...` for private notes, but custom spaces
may use different defaults or grant only selected paths. Choose a tree from the
user's instructions, the project's memory map, prior memories, or visible tree
structure. If the right writable tree is unclear, ask the user before storing.

## Store Useful Memories

Use `me_memory_create` for knowledge that should survive this conversation.
Good memories are concise, self-contained, and reusable.

Prefer this:

```json
{
  "tree": "/share/decisions/auth",
  "name": "device-flow-session-token",
  "content": "Device login returns a bearer session token, not an OAuth refresh token. Treat it as a 7-day sliding session accepted by the resource-server middleware.",
  "meta": { "type": "decision", "topic": "auth" }
}
```

Avoid this:

```json
{
  "tree": "/share/random",
  "content": "Fixed it."
}
```

Use a stable `name` when the memory is likely to be referenced or updated later.
If you are updating the same fact, prefer `me_memory_update` on the existing named
memory instead of creating duplicates.

## Use Destructive Tools Carefully

`me_memory_delete`, `me_memory_delete_by_path`, `me_memory_delete_tree`,
`me_memory_mv`, and `me_memory_copy` can change or remove shared knowledge. Use
them only when the user asks, when project instructions explicitly authorize the
operation, or when the intent is clear from the task.

## Tool Reference

See [MCP Tool Reference](index.md) for parameter and return-value documentation
for each tool.
