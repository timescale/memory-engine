# TypeScript Client

The `@memory.build/client` package provides programmatic access to Memory Engine from TypeScript and JavaScript.

## Install

```bash
npm install @memory.build/client
```

## Quick start

```typescript
import { createClient } from "@memory.build/client";

const me = createClient({
  url: "https://api.memory.build",
  apiKey: "me.xxx.yyy",
});

// Create a memory
await me.memory.create({
  content: "TypeScript was released in 2012",
  tree: "knowledge.programming",
});

// Search
const { results } = await me.memory.search({
  semantic: "when was TypeScript created",
});
```

## Configuration

```typescript
const me = createClient({
  url: "https://api.memory.build",  // default
  apiKey: "me.xxx.yyy",         // format: "me.<lookupId>.<secret>"
  timeout: 30000,               // request timeout in ms (default: 30000)
  retries: 3,                   // automatic retries (default: 3)
});
```

The client retries on `429`, `500`, `502`, `503`, and `504` responses with exponential backoff and jitter. It respects the `Retry-After` header.

## Memory operations

### create

```typescript
const memory = await me.memory.create({
  content: "The fact to remember",
  tree: "work.projects.acme",          // optional hierarchical path
  meta: { source: "meeting-notes" },   // optional JSON metadata
  temporal: {                          // optional time range
    start: "2025-01-01T00:00:00Z",
    end: "2025-01-31T23:59:59Z",
  },
});
// memory.id, memory.content, memory.tree, memory.meta, ...
```

### batchCreate

Create up to 1,000 memories in a single call.

```typescript
const { ids } = await me.memory.batchCreate({
  memories: [
    { content: "First memory", tree: "notes" },
    { content: "Second memory", tree: "notes" },
  ],
});
```

### get

```typescript
const memory = await me.memory.get({ id: "019..." });
```

### update

Only provided fields are changed. Pass `null` to clear optional fields.

```typescript
const updated = await me.memory.update({
  id: "019...",
  content: "Updated content",
  meta: { reviewed: true },
});
```

### delete

```typescript
const { deleted } = await me.memory.delete({ id: "019..." });
```

### deleteTree

Delete all memories under a tree prefix.

```typescript
// Preview what would be deleted
const { count } = await me.memory.deleteTree({ tree: "old.project", dryRun: true });

// Actually delete
const { count: deleted } = await me.memory.deleteTree({ tree: "old.project" });
```

### move

Move memories from one tree prefix to another, preserving subtree structure.

```typescript
const { count } = await me.memory.move({
  source: "drafts.api",
  destination: "published.api",
});
```

### tree

View the hierarchical tree structure with counts at each node.

```typescript
const { nodes } = await me.memory.tree();
// [{ path: "work", count: 5 }, { path: "work.projects", count: 3 }, ...]

// Scoped to a subtree
const { nodes } = await me.memory.tree({ tree: "work", levels: 2 });
```

## Search

The `search` method supports keyword, semantic, and hybrid search with multiple filter types.

```typescript
const { results, total } = await me.memory.search({
  // Search modes (use one or both for hybrid)
  semantic: "natural language meaning query",
  fulltext: "exact keyword BM25 match",

  // Filters (all optional, combined with AND)
  grep: "regex.*pattern",              // POSIX regex on content
  tree: "work.projects.*",             // ltree/lquery filter
  meta: { source: "meeting-notes" },   // JSONB containment
  temporal: {                          // time-based filter
    contains: "2025-06-15T00:00:00Z",  // point-in-time
    // OR overlaps: { start, end }
    // OR within: { start, end }
  },

  // Tuning
  limit: 10,                           // max results (1-1000)
  candidateLimit: 30,                  // candidates per mode before RRF fusion
  weights: { semantic: 0.7, fulltext: 0.3 },
  orderBy: "desc",                     // for filter-only queries (no search)
});

for (const { memory, score } of results) {
  console.log(score, memory.content);
}
```

## Error handling

The client throws `RpcError` for application errors. Each error has a numeric `code` and an optional string `appCode` for programmatic matching.

```typescript
import { createClient, RpcError } from "@memory.build/client";

try {
  await me.memory.get({ id: "nonexistent" });
} catch (error) {
  if (error instanceof RpcError) {
    console.error(error.message);  // human-readable message

    if (error.is("NOT_FOUND")) {
      // handle missing memory
    }
  }
}
```

### Error codes

| `appCode` | Meaning |
|-----------|---------|
| `NOT_FOUND` | Resource doesn't exist |
| `UNAUTHORIZED` | Missing or invalid API key |
| `FORBIDDEN` | Insufficient permissions |
| `CONFLICT` | Duplicate or conflicting operation |
| `RATE_LIMITED` | Too many requests |
| `VALIDATION_ERROR` | Invalid input |
| `EMBEDDING_NOT_CONFIGURED` | Semantic search without embedding provider |
| `EMBEDDING_FAILED` | Embedding generation failed |
| `INTERNAL_ERROR` | Server error |

## Access control

The client exposes namespaces for managing users, grants, roles, and owners. These mirror the [Access Control](access-control.md) system.

### Users

```typescript
const user = await me.user.create({ name: "alice" });
const user = await me.user.get({ id: "019..." });
const user = await me.user.getByName({ name: "alice" });
const { users } = await me.user.list();
await me.user.rename({ id: "019...", name: "bob" });
await me.user.delete({ id: "019..." });
```

### Grants

```typescript
await me.grant.create({
  userId: "019...",
  treePath: "team.shared",
  actions: ["read", "write"],
  withGrantOption: false,
});
const { grants } = await me.grant.list({ userId: "019..." });
const { allowed } = await me.grant.check({
  userId: "019...",
  treePath: "team.shared",
  action: "write",
});
await me.grant.revoke({ userId: "019...", treePath: "team.shared" });
```

### Roles

```typescript
const role = await me.role.create({ name: "editors" });
await me.role.addMember({ roleId: role.id, memberId: userId });
await me.role.removeMember({ roleId: role.id, memberId: userId });
const { members } = await me.role.listMembers({ roleId: role.id });
const { roles } = await me.role.listForUser({ userId });
```

### Owners

```typescript
await me.owner.set({ userId: "019...", treePath: "team.shared" });
const owner = await me.owner.get({ treePath: "team.shared" });
const { owners } = await me.owner.list();
await me.owner.remove({ treePath: "team.shared" });
```

### API keys

```typescript
const { apiKey, rawKey } = await me.apiKey.create({
  userId: "019...",
  name: "ci-pipeline",
  expiresAt: "2026-01-01T00:00:00Z",  // optional
});
console.log(rawKey);  // "me.xxx.yyy" — only shown once

const { apiKeys } = await me.apiKey.list({ userId: "019..." });
await me.apiKey.revoke({ id: apiKey.id });
await me.apiKey.delete({ id: apiKey.id });
```

## Protocol

The client communicates over JSON-RPC 2.0 via a single HTTP endpoint (`POST /api/v1/engine/rpc`). Authentication is via `Authorization: Bearer <apiKey>` header.

You can make raw RPC calls using the `call` method:

```typescript
const result = await me.call("memory.search", { semantic: "hello" });
```

The API key can be swapped at runtime:

```typescript
me.setApiKey("me.newkey.newsecret");
```
