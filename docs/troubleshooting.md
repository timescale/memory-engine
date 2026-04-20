# Troubleshooting

## Common issues

### Search returns no results

1. **Check embedding status** -- semantic search requires embeddings. New memories take ~10-30 seconds to get embeddings. Use `me memory get <id>` and check `hasEmbedding`.
2. **Try fulltext instead** -- fulltext search works immediately after creation. Use `--fulltext` to search by keywords.
3. **Broaden the search** -- remove filters (tree, meta, temporal) to see if results appear without them.
4. **Check access** -- RLS silently filters results. If you're missing memories you know exist, check grants with `me grant check <user> <path> read`. See [Access Control](access-control.md) for details.
5. **Check as superuser** -- superusers bypass all access checks. If results appear for a superuser but not a regular user, the issue is grants.

### "Memory not found" on get or update

This can mean either:

- The memory genuinely doesn't exist (wrong ID)
- The memory exists but the current user doesn't have `read` access to its tree path (RLS returns "not found")

Check access with `me grant check <user> <path> read` or retry as a superuser.

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
| `RATE_LIMITED` | Too many requests | Back off and retry after the `Retry-After` header |
| `VALIDATION_ERROR` | Business logic validation failed | Check the error message for details |
