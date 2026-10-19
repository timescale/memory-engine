# Troubleshooting

## Common issues

### I logged in but don't see my space or invitation

1. **Check which account you're using** -- run `me whoami` and confirm the email matches the one that was invited. If it doesn't, run `me login --switch` and sign in with the invited GitHub or Google account.
2. **Check pending invitations** -- run `me invite list`. If the invitation appears, accept it with `me invite accept <invitation-id>`.
3. **Redeem invite links directly** -- if you received a link, run `me invite redeem <invite-url>` while signed in as the invited account.
4. **Select the space** -- after accepting, run `me space list` and `me space use <slug-or-name>` if the new space is not active.
5. **Headless environment?** -- use `me login --device` on SSH, remote VMs, containers, or other environments where the browser-based login cannot open locally.

See [Joining a Space](joining-a-space.md) for the full invitee walkthrough.

### "Login expired or revoked"

Run `me login` again (or `me --server <url> login` for a specific server). In a
headless environment, use `me login --device`. Once the server definitively
rejects the saved refresh credential, the CLI stops retrying it and asks you to
sign in again. Repeated commands will not repair that credential. If your local
credential store is read-only or failing, fix that too: the rejected-login state
may not survive a client restart until it can be saved.

The CLI still recovers when another local process has already saved a newer
login, and temporary network failures remain retryable. If a long-running
client continues to fail after you sign in, restart it. Login, logout and
background refresh coordinate so a rejected older login cannot overwrite a new
one; background failures also leave your default server unchanged. A generic
authentication failure does not automatically delete a newer saved login.
`me serve` reports a terminal login rejection as an authentication failure,
not a retryable connection failure.

On keychain-enabled hosts, updated clients share the selected credential store
across different `XDG_CONFIG_HOME` settings. A temporary keychain outage does not
move an active fallback out from under file-only clients, and a later explicit
login can replace stale shared rejection state. If shared credential metadata is
damaged, retry an explicit login or logout after checking that your home config
directory is writable. Unmounted or unreadable private fallback stores may need
to be cleared in the environment that owns them.

For a sandbox with a read-only home, use `ME_NO_KEYCHAIN=1` with a writable
`XDG_CONFIG_HOME` and sign in there; that mode uses only its private file store.

An injected `ME_SESSION_TOKEN` is not automatically refreshed: replace or remove that
override, or fix `ME_API_KEY` if you are using key-based authentication.

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
