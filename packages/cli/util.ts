/**
 * Shared CLI utilities.
 *
 * Common patterns used across multiple command files:
 * - Session / active-space validation
 * - Memory / user client construction
 * - Principal / agent resolution
 * - Error handling
 */
import * as clack from "@clack/prompts";
import type { MemoryClient, UserClient } from "./client.ts";
import { createMemoryClient, createUserClient, RpcError } from "./client.ts";
import { clearSessionToken, type ResolvedCredentials } from "./credentials.ts";
import type { OutputFormat } from "./output.ts";
import { output } from "./output.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Ensure the user has a session token. Exits with an error if not.
 */
export function requireSession(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): asserts creds is ResolvedCredentials & { sessionToken: string } {
  if (!creds.sessionToken) {
    if (fmt === "text") {
      clack.log.error("Not logged in. Run 'me login' first.");
    } else {
      output({ error: "Not logged in" }, fmt, () => {});
    }
    process.exit(1);
  }
}

/**
 * Ensure an active space (the X-Me-Space) is selected. Exits with an error if
 * not. Used by the space-scoped commands (memory, group, access, …).
 */
export function requireSpace(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): asserts creds is ResolvedCredentials & { activeSpace: string } {
  if (!creds.activeSpace) {
    if (fmt === "text") {
      clack.log.error(
        "No active space. Run 'me space use <space>' to select one, or set ME_SPACE.",
      );
    } else {
      output({ error: "No active space" }, fmt, () => {});
    }
    process.exit(1);
  }
}

/**
 * Build a user client (session-only, /api/v1/user/rpc). Call requireSession
 * first so the token is present.
 */
export function buildUserClient(
  creds: ResolvedCredentials & { sessionToken: string },
): UserClient {
  return createUserClient({ url: creds.server, token: creds.sessionToken });
}

/**
 * Build a memory client (session + active space, /api/v1/memory/rpc). Call
 * requireSession and requireSpace first so both are present.
 */
export function buildMemoryClient(
  creds: ResolvedCredentials & { sessionToken: string; activeSpace: string },
): MemoryClient {
  return createMemoryClient({
    url: creds.server,
    token: creds.sessionToken,
    space: creds.activeSpace,
  });
}

/**
 * Resolve a principal in the active space to its id. Accepts a UUIDv7 (used
 * as-is) or a name — for users the name is their email; for agents/groups it is
 * the display name. Optionally constrained to a kind ('u' | 'a' | 'g'). Listing
 * principals requires space-manager authority; callers without it should pass a
 * UUID. Exits with an actionable error on miss / ambiguity.
 */
export async function resolveSpacePrincipalId(
  memory: MemoryClient,
  input: string,
  fmt: OutputFormat,
  kind?: "u" | "a" | "g",
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;

  const { principals } = await memory.principal.list(kind ? { kind } : {});
  const lower = input.toLowerCase();
  const matches = principals.filter((p) => p.name.toLowerCase() === lower);

  if (matches.length === 1 && matches[0]) return matches[0].id;

  if (matches.length === 0) {
    const msg = `No ${kind === "g" ? "group" : "principal"} named '${input}' in this space.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  const msg = `Multiple principals named '${input}'. Use the id instead:`;
  if (fmt === "text") {
    clack.log.error(msg);
    for (const m of matches) console.log(`  ${m.name} (${m.kind}) — ${m.id}`);
  } else {
    output({ error: msg, matches }, fmt, () => {});
  }
  process.exit(1);
}

/**
 * Resolve one of the caller's agents to its id, by UUIDv7 or name (agent names
 * are unique per user). Exits with an actionable error on miss / ambiguity.
 */
export async function resolveAgentId(
  user: UserClient,
  input: string,
  fmt: OutputFormat,
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;
  const { agents } = await user.agent.list();
  const lower = input.toLowerCase();
  const matches = agents.filter((a) => a.name.toLowerCase() === lower);
  if (matches.length === 1 && matches[0]) return matches[0].id;

  const msg =
    matches.length === 0
      ? `No agent named '${input}'. Run 'me agent list'.`
      : `Multiple agents named '${input}'. Use the agent id instead.`;
  if (fmt === "text") {
    clack.log.error(msg);
    if (matches.length > 1)
      for (const a of matches) console.log(`  ${a.name} — ${a.id}`);
  } else {
    output({ error: msg, matches }, fmt, () => {});
  }
  process.exit(1);
}

/**
 * Detect an authentication error from the server.
 *
 * The server's `unauthorized()` helper sends an HTTP 401 with body
 * `{"error":{"message": "...", "code": "UNAUTHORIZED"}}`. The transport wraps
 * that into an RpcError. The string code lands either on `data.code`
 * (`appCode`) or on `code` itself depending on which envelope path the
 * response took, so we check both.
 */
function isUnauthorized(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  if (error.appCode === "UNAUTHORIZED") return true;
  // The server's HTTP error envelope puts the string code on the top-level
  // `code` field. RpcError types `code` as number, but the runtime value can
  // be a string when the response wasn't a strict JSON-RPC envelope.
  return (error.code as unknown) === "UNAUTHORIZED";
}

/**
 * Handle an error from an RPC call. Formats per output mode and exits.
 *
 * Pass `opts.sessionServer` for commands that authenticate with a session
 * token. When the server returns UNAUTHORIZED we clear the stored token for
 * that server (so the next command says "Not logged in") and replace the
 * generic message with an actionable "Run 'me login' to sign in again." hint.
 */
export function handleError(
  error: unknown,
  fmt: OutputFormat,
  opts?: { sessionServer?: string },
): never {
  let msg =
    error instanceof RpcError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  let code: string | undefined;

  if (opts?.sessionServer && isUnauthorized(error)) {
    clearSessionToken(opts.sessionServer);
    msg = "Session expired. Run 'me login' to sign in again.";
    code = "UNAUTHORIZED";
  }

  if (fmt === "text") {
    clack.log.error(msg);
  } else {
    output(code ? { error: msg, code } : { error: msg }, fmt, () => {});
  }
  process.exit(1);
}
