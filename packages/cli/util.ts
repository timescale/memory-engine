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
import { clearTokens, type ResolvedCredentials } from "./credentials.ts";
import type { OutputFormat } from "./output.ts";
import { output } from "./output.ts";
import { memoryBearer, userBearer } from "./session.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Ensure a human is logged in. Exits with an error if not.
 *
 * Use this for the user endpoint (/api/v1/user/rpc), which is session-only — an
 * api key never authenticates there (agents can't manage agents). For the memory
 * endpoint, which accepts either bearer, use {@link requireMemoryAuth}.
 */
export function requireSession(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): void {
  if (!creds.loggedIn) {
    if (fmt === "text") {
      clack.log.error("Not logged in. Run 'me login' first.");
    } else {
      output({ error: "Not logged in" }, fmt, () => {});
    }
    process.exit(1);
  }
}

/**
 * Ensure the caller can authenticate to the memory endpoint
 * (/api/v1/memory/rpc), which accepts either bearer: an agent api key
 * (ME_API_KEY) or a logged-in human. Exits with an error if neither is present.
 * Pair with {@link requireSpace}; then {@link buildMemoryClient} picks the
 * bearer (api key first, mirroring `me mcp`).
 */
export function requireMemoryAuth(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): void {
  if (!creds.apiKey && !creds.loggedIn) {
    const msg =
      "Not authenticated. Run 'me login', or set ME_API_KEY for an agent.";
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
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
 * first. The bearer is the human's OAuth access token, resolved (and refreshed)
 * lazily per call via {@link userBearer}.
 */
export function buildUserClient(creds: ResolvedCredentials): UserClient {
  return createUserClient({ url: creds.server, ...userBearer(creds.server) });
}

/**
 * Build a memory client (bearer + active space, /api/v1/memory/rpc). Call
 * requireMemoryAuth and requireSpace first so a bearer and a space are present.
 * The bearer is the agent api key when set (ME_API_KEY, static), else the
 * human's OAuth access token (refreshed by {@link memoryBearer}) — the memory
 * endpoint accepts either, and this mirrors `me mcp`'s precedence.
 */
export function buildMemoryClient(
  creds: ResolvedCredentials & { activeSpace: string },
): MemoryClient {
  return createMemoryClient({
    url: creds.server,
    ...memoryBearer(creds.server, creds.apiKey),
    space: creds.activeSpace,
    // Bulk imports send 1000-memory batchCreate chunks that the server
    // processes row-by-row; on a loaded server (or one far from its
    // database) a chunk can legitimately exceed the client's 30s default.
    timeout: 120_000,
  });
}

/**
 * Resolve a principal in the active space to its id. Accepts a UUIDv7 (used
 * as-is) or a name — for users the name is their email; for agents/groups it is
 * the display name. Optionally constrained to a kind ('u' | 'a' | 'g'). Uses
 * principal.resolve (a targeted lookup any space member may call). Exits with an
 * actionable error on miss / ambiguity.
 */
export async function resolveSpacePrincipalId(
  memory: MemoryClient,
  input: string,
  fmt: OutputFormat,
  kind?: "u" | "a" | "g",
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;

  const { principals } = await memory.principal.resolve(
    kind ? { name: input, kind } : { name: input },
  );

  if (principals.length === 1 && principals[0]) return principals[0].id;

  if (principals.length === 0) {
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
    for (const m of principals)
      console.log(`  ${m.name} (${m.kind}) — ${m.id}`);
  } else {
    output({ error: msg, matches: principals }, fmt, () => {});
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
 * True when `error` is a server AppError with the given string code. The code
 * lands either on `data.code` (`appCode`) or on `code` itself depending on which
 * envelope path the response took (RpcError types `code` as number, but the
 * runtime value can be the string code when the response wasn't a strict
 * JSON-RPC envelope), so we check both.
 */
export function isAppErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof RpcError)) return false;
  return error.appCode === code || (error.code as unknown) === code;
}

/**
 * Detect an authentication error from the server (HTTP 401 / `UNAUTHORIZED`).
 */
function isUnauthorized(error: unknown): boolean {
  return isAppErrorCode(error, "UNAUTHORIZED");
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
    clearTokens(opts.sessionServer);
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
