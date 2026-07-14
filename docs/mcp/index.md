# MCP Tool Reference

Memory Engine exposes 15 tools to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io/). Once an agent is connected (see [MCP Integration](../mcp-integration.md)), it can inspect its context, store, search, and organize memories with the tools below.

If you are an agent using these tools, start with [MCP Agent Instructions](agent-instructions.md) for when to search, what to store, and how access control affects visible and writable trees.

## Context

| Tool | Purpose |
|------|---------|
| [`me_memory_context`](me_memory_context.md) | Show current identity, active space, and effective access |

## Storing and editing

| Tool | Purpose |
|------|---------|
| [`me_memory_create`](me_memory_create.md) | Store a new memory |
| [`me_memory_update`](me_memory_update.md) | Modify an existing memory |
| [`me_memory_delete`](me_memory_delete.md) | Delete a memory by ID |
| [`me_memory_delete_by_path`](me_memory_delete_by_path.md) | Delete a named memory by its `tree/name` path |
| [`me_memory_delete_tree`](me_memory_delete_tree.md) | Delete every memory under a tree prefix |

## Retrieving and searching

| Tool | Purpose |
|------|---------|
| [`me_memory_search`](me_memory_search.md) | Search by meaning, keywords, or filters |
| [`me_memory_get`](me_memory_get.md) | Retrieve a memory by ID |
| [`me_memory_get_by_path`](me_memory_get_by_path.md) | Retrieve a named memory by its `tree/name` path |
| [`me_memory_count`](me_memory_count.md) | Count memories matching a tree filter |
| [`me_memory_tree`](me_memory_tree.md) | View the tree structure with counts |

## Organizing and moving

| Tool | Purpose |
|------|---------|
| [`me_memory_copy`](me_memory_copy.md) | Copy memories between tree paths |
| [`me_memory_mv`](me_memory_mv.md) | Move memories between tree paths |

## Bulk import and export

| Tool | Purpose |
|------|---------|
| [`me_memory_import`](me_memory_import.md) | Bulk import from a file or inline content |
| [`me_memory_export`](me_memory_export.md) | Bulk export with filters |

See [File Formats](../formats.md) for the import/export schemas, and [Core Concepts](../concepts.md) for the memory model behind these tools.
