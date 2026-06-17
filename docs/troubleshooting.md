# Troubleshooting

## Common issues

### Search returns no results

1. **Check embedding status** -- semantic search requires embeddings. New memories take ~10-30 seconds to get embeddings. Use `me memory get <id>` and check `hasEmbedding`.
2. **Try fulltext instead** -- fulltext search works immediately after creation. Use `--fulltext` to search by keywords.
3. **Broaden the search** -- remove filters (tree, meta, temporal) to see if results appear without them.
4. **Check the active space** -- results come only from your active space. Run `me whoami` to confirm it, and `me space use <slug>` to switch.
5. **Check access** -- the server filters results to the tree paths you can read; a missing grant looks like missing results, not an error. List your grants with `me access list <your-principal>` (or `me access list --path <path>`). See [Access Control](access-control.md) for details.

### "Memory not found" on get or update

This can mean either:

- The memory genuinely doesn't exist (wrong ID), or it's in a different space than your active one
- The memory exists but you don't have `read` access to its tree path (access filtering reports it as "not found")

Confirm your active space with `me whoami` and check your grants with `me access list <your-principal>`.

### Embeddings stuck

The embedding worker retries up to 3 times per memory. Common failure causes:

- **Provider API errors** -- rate limits, outages
- **Content too large** -- extremely long content may fail truncation

After 3 failures, the memory stays without an embedding. It's still searchable via fulltext and filters, just not semantic search.

## JSON-RPC error codes

### Protocol errors

| Code | Meaning | Recovery |
|------|---------|----------|
| `-32700` | Parse error (invalid JSON) | Fix the request body |
| `-32600` | Invalid request (missing `jsonrpc`, `method`, or `id`) | Fix the request envelope |
| `-32601` | Method not found | Check the method name |
| `-32602` | Invalid params (Zod validation failed) | Check parameter types and required fields |
| `-32603` | Internal error | Server-side issue; retry or report |

### Application errors (code: -32000)

These all use code `-32000` but are distinguished by `data.code`:

| `data.code` | Meaning | Recovery |
|-------------|---------|----------|
| `UNAUTHORIZED` | Missing or invalid credentials | Check API key or session token |
| `FORBIDDEN` | Valid credentials, insufficient permissions | Check grants for the required action |
| `NOT_FOUND` | Resource doesn't exist (or no access) | Verify the ID and check grants |
| `CONFLICT` | Resource already exists (e.g., duplicate slug) | Use a different identifier |
| `LAST_ADMIN` | Operation would leave the space with no effective admin | Promote another user/admin group first |
| `RATE_LIMITED` | Too many requests | Back off and retry after the `Retry-After` header |
| `VALIDATION_ERROR` | Business logic validation failed | Check the error message for details |
| `QUERY_TIMEOUT` | A database statement exceeded the server runtime timeout | Retry later or narrow the request |
| `LOCK_TIMEOUT` | A database statement waited too long for a lock | Retry later |
| `TRANSACTION_TIMEOUT` | A database transaction exceeded the server runtime timeout | Retry later or report if it persists |
