# TypeScript Client

The `@memory.build/client` package provides programmatic access to Memory Engine from TypeScript and JavaScript.

## Install

```bash
npm install @memory.build/client
```

## Two clients

The package exposes two clients, matching the two API endpoints:

- **`createMemoryClient`** — the space data plane plus space management. Talks to `POST /api/v1/memory/rpc`, carrying the active space in the `X-Me-Space` header. Authenticates with a session token, OAuth token, user PAT, agent API key, or service-account API key. Namespaces: `memory`, `principal`, `group`, `grant`, `invite`.
- **`createUserClient`** — user/account and service-account management. Talks to `POST /api/v1/user/rpc`. Authenticates with a session/OAuth token or the user's own PAT; agent and service-account keys are limited and cannot manage accounts or mint keys. Methods: `whoami`, plus the `agent`, `serviceAccount`, `apiKey`, and `space` namespaces.

There is also `createAuthClient` for the browser/OAuth login flows that produce a session token.

## Quick start

```typescript
import { createMemoryClient } from "@memory.build/client";

const me = createMemoryClient({
  url: "https://api.memory.build",  // default
  token: sessionTokenOrApiKey,      // session token or "me.<lookupId>.<secret>"
  space: "abc123def456",            // the X-Me-Space slug
});

// Create a memory (tree is required — choose /share/* or ~/* deliberately)
await me.memory.create({
  content: "TypeScript was released in 2012",
  tree: "/share/knowledge/programming",
});

// Search
const { results } = await me.memory.search({
  semantic: "when was TypeScript created",
});
```

## Configuration

```typescript
const me = createMemoryClient({
  url: "https://api.memory.build",  // default
  token: "me.xxx.yyy",              // session token or api key (format: "me.<lookupId>.<secret>")
  space: "abc123def456",            // active space slug (sent as X-Me-Space)
  timeout: 30000,                   // request timeout in ms (default: 30000)
  retries: 3,                       // automatic retries (default: 3)
});
```

The client retries on `429`, `500`, `502`, `503`, and `504` responses with exponential backoff and jitter, and respects the `Retry-After` header. The token and space can be swapped at runtime:

```typescript
me.setToken("me.newkey.newsecret");
me.setSpace("otherslug1234");
```

## Memory operations

### create

`tree` is required. Use `/share/*` for memories the rest of the space should see, or `~/*` for your private home. An optional `name` (a filename-like slug, unique within the tree) lets you address the memory by path. `onConflict` governs a clash on the idempotency key (the `id` if given, else the `(tree, name)` slot): `"error"` (default), `"replace"` (content-aware), or `"ignore"`.

```typescript
const memory = await me.memory.create({
  content: "The fact to remember",
  tree: "/share/work/projects/acme",   // required (leading slash optional on input)
  name: "kickoff",                     // optional, unique within the tree
  meta: { source: "meeting-notes" },   // optional JSON metadata
  temporal: {                          // optional time range
    start: "2025-01-01T00:00:00Z",
    end: "2025-01-31T23:59:59Z",
  },
  onConflict: "replace",               // optional; default "error"
});
// memory.id, memory.content, memory.tree, memory.name, memory.meta, ...
```

### batchCreate

Create up to 1,000 memories in a single call. Each memory requires a `tree`. A batch-level `onConflict` applies to every row (importers pass `"replace"` or `"ignore"`).

```typescript
const { results } = await me.memory.batchCreate({
  memories: [
    { content: "First memory", tree: "/share/notes" },
    { content: "Second memory", tree: "/share/notes", name: "second" },
  ],
  onConflict: "ignore", // optional; default "error"
});
// `results` has one { id, status } per input, in order — status is
// "inserted" | "updated" | "skipped". Filter by status for counts/ids:
const insertedIds = results
  .filter((r) => r.status === "inserted")
  .map((r) => r.id);
```

### get / getByPath

```typescript
const memory = await me.memory.get({ id: "019..." });
// Or address a named memory by its tree/name path:
const byPath = await me.memory.getByPath({ path: "/share/auth/jwt-rotation" });
```

### update

Only provided fields are changed. Pass `null` to clear optional fields (e.g. `name: null` clears the name). Update is id-addressed.

```typescript
const updated = await me.memory.update({
  id: "019...",
  content: "Updated content",
  name: "jwt-rotation",   // set/rename; null clears
  meta: { reviewed: true },
});
```

### delete / deleteByPath

```typescript
const { deleted } = await me.memory.delete({ id: "019..." });
// Or delete a named memory by its tree/name path:
await me.memory.deleteByPath({ path: "/share/auth/jwt-rotation" });
```

### deleteTree

Delete all memories under a tree prefix.

```typescript
const { count } = await me.memory.deleteTree({ tree: "/share/old/project", dryRun: true });
const { count: deleted } = await me.memory.deleteTree({ tree: "/share/old/project" });
```

### move

Move memories from one tree prefix to another, preserving subtree structure.

```typescript
const { count } = await me.memory.move({
  source: "/share/drafts/api",
  destination: "/share/published/api",
});
```

### tree

View the hierarchical tree structure with counts at each node.

```typescript
const { nodes } = await me.memory.tree();
// [{ path: "/share", count: 5 }, { path: "/share/work", count: 3 }, ...]

const { nodes } = await me.memory.tree({ tree: "/share/work", levels: 2 });
```

## Search

The `search` method supports keyword, semantic, and hybrid search with multiple filter types.

```typescript
const { results } = await me.memory.search({
  // Search modes (use one or both for hybrid)
  semantic: "natural language meaning query",
  fulltext: "exact keyword BM25 match",

  // Filters (all optional, combined with AND)
  grep: "regex.*pattern",              // POSIX regex on content
  tree: "/share/work/projects/*",       // ltree/lquery filter
  meta: { source: "meeting-notes" },   // JSONB containment
  temporal: {                          // time-based filter
    contains: "2025-06-15T00:00:00Z",  // point-in-time
    // OR overlaps: { start, end }
    // OR within: { start, end }
  },

  // Tuning
  limit: 10,                           // max results (1-1000)
  candidateLimit: 30,                  // candidates per mode before RRF fusion
  semanticThreshold: 0.7,              // optional min semantic score (0-1)
  weights: { semantic: 0.7, fulltext: 0.3 },
  orderBy: "desc",                     // for filter-only queries (no search)
});

for (const { memory, score } of results) {
  console.log(score, memory.content);
}
```

## Space management

The memory client also exposes the in-space management namespaces. These require the appropriate authority (admin for roster/groups/invites; `owner@path` for grants). See [Access Control](access-control.md).

### principal — the roster

```typescript
const { principals } = await me.principal.list();            // admin only
await me.principal.add({ principalId: "019..." });
await me.principal.remove({ principalId: "019..." });
const { principals } = await me.principal.resolve({ name: "alice@example.com" });    // any member
const { principals } = await me.principal.lookup({ ids: ["019..."] });               // any member
```

### group

```typescript
const group = await me.group.create({ name: "backend" });
const { groups } = await me.group.list();
await me.group.rename({ groupId: group.id, name: "backend-team" });
await me.group.delete({ groupId: group.id });
await me.group.addMember({ groupId: group.id, memberId: "019...", admin: false });
await me.group.removeMember({ groupId: group.id, memberId: "019..." });
const { members } = await me.group.listMembers({ groupId: group.id });
const { groups } = await me.group.listForMember({ memberId: "019..." });
```

### grant — tree access

Levels are `1` (read), `2` (write), `3` (owner).

```typescript
await me.grant.set({ principalId: "019...", treePath: "/share/work", access: 2 });
await me.grant.remove({ principalId: "019...", treePath: "/share/work" });
const { grants } = await me.grant.list();                         // optionally { principalId } / { treePath }
// Enumerating others' grants needs admin / path owner; passing your own principalId
// (or an agent you own) is self-service — any member can list their own grants.
```

### invite

```typescript
// shareAccess is a level number (1=read, 2=write, 3=owner) at the shared root; null/omit = none
const invite = await me.invite.create({ email: "alice@example.com", admin: false, shareAccess: 1 });
const { invitations } = await me.invite.list();
await me.invite.revoke({ email: "alice@example.com" });
```

## User-scoped operations

Use `createUserClient` for identity, agents, service accounts, API keys, and space discovery. API-key minting and revocation still require a human session/OAuth credential; keys cannot mint or revoke other keys.

```typescript
import { createUserClient } from "@memory.build/client";

const user = createUserClient({ token: sessionTokenOrUserPat });

// Identity
const me = await user.whoami();

// Spaces — discover and manage the spaces you belong to
const { spaces } = await user.space.list();
const space = await user.space.create({ name: "My Space" });   // → { id, slug }
await user.space.rename({ slug: space.slug, name: "Renamed" });
await user.space.delete({ slug: space.slug });

// Agents — non-human identities owned by you
const agent = await user.agent.create({ name: "ci-bot" });     // → { id }
const { agents } = await user.agent.list();
await user.agent.rename({ id: agent.id, name: "ci-runner" });
await user.agent.delete({ id: agent.id });

// Service accounts — team-owned operational identities in a space.
// User RPC service-account methods use the space id, not the slug.
const { serviceAccount: service } = await user.serviceAccount.create({
  spaceId: space.id,
  name: "deploy-bot",
  adminMembers: [{ memberId: "019...", admin: true }],
});
const { serviceAccounts } = await user.serviceAccount.list({ spaceId: space.id });
await user.serviceAccount.rename({ id: service.id, name: "deployer" });

// API keys — global per-principal credentials
const { id, key } = await user.apiKey.create({
  memberId: agent.id,
  name: "ci-pipeline",
  expiresAt: "2026-01-01T00:00:00Z",  // optional
});
console.log(key);  // "me.xxx.yyy" — full key returned once; only its hash is stored
const { apiKeys } = await user.apiKey.list({ memberId: agent.id });
const apiKeyMeta = await user.apiKey.get({ id });
await user.apiKey.delete({ id });

// Service-account keys target the service account instead of an agent.
const serviceKey = await user.apiKey.create({
  memberId: service.id,
  name: "production-deploy",
});
```

API keys are **global** per-principal credentials, not bound to a space: the same key works in any space its principal has been admitted to (the space comes from `X-Me-Space`). Service accounts are themselves space-scoped, so a service-account key is only useful in that service account's space.

## Error handling

The client throws `RpcError` for application errors. Each error has a numeric `code` and an optional string `appCode` for programmatic matching.

```typescript
import { createMemoryClient, RpcError } from "@memory.build/client";

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
| `NOT_FOUND` | Resource doesn't exist (or not visible to you) |
| `UNAUTHORIZED` | Missing or invalid session token / API key |
| `FORBIDDEN` | Insufficient permissions |
| `CONFLICT` | Duplicate or conflicting operation |
| `LAST_ADMIN` | Operation would leave the space with no effective admin |
| `RATE_LIMITED` | Too many requests |
| `VALIDATION_ERROR` | Invalid input |
| `QUERY_TIMEOUT` | Database statement timed out |
| `LOCK_TIMEOUT` | Database lock wait timed out |
| `TRANSACTION_TIMEOUT` | Database transaction timed out |
| `EMBEDDING_NOT_CONFIGURED` | Semantic search without embedding provider |
| `EMBEDDING_FAILED` | Embedding generation failed |
| `INTERNAL_ERROR` | Server error |

## Protocol

Both clients speak JSON-RPC 2.0 over HTTP. The memory client uses `POST /api/v1/memory/rpc` with `Authorization: Bearer <token>` and a required `X-Me-Space: <slug>` header; the user client uses `POST /api/v1/user/rpc` with a session/OAuth/PAT bearer for management operations. See the [Access Control](access-control.md) guide for the authority model behind the management namespaces.
