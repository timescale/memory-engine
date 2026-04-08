# Server Production Readiness TODO

Remaining items before the server is fully production-ready.

## Must Have

### Device Flow State Cleanup
The OAuth device flow uses an in-memory `deviceStates` map that grows unbounded. Needs either:
- Periodic cleanup via `setInterval`
- Move to database/Redis
- Add TTL-based eviction

**Files:** `packages/server/auth/device-flow.ts`

## Nice to Have

### Engine Delete
The accounts RPC has `engine.create`, `engine.list`, `engine.get`, `engine.update` but no `engine.delete`. May be intentional (soft delete via status change to "deleted").

**Decision needed:** Confirm if soft delete is sufficient or add hard delete.

### CORS Headers
No CORS middleware. Only needed if browser clients call the API directly (not through a backend proxy).

**Scope:** Add CORS middleware if browser clients are a use case.

### Request ID Headers
No `X-Request-Id` header generation or propagation. Telemetry spans exist but no easy way to correlate logs with requests from outside.

**Scope:** Generate UUID per request, add to response headers, include in logs.

---

## Completed

- [x] 39 RPC methods (25 engine, 14 accounts)
- [x] Authentication (API key + session token)
- [x] OAuth device flow (Google/GitHub)
- [x] Rate limiting (removed - use edge provider instead)
- [x] Size limiting
- [x] Telemetry/observability
- [x] Semantic search query embedding
- [x] Session logout (`session.revoke` RPC method)
