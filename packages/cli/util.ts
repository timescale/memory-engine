/**
 * Shared CLI utilities.
 *
 * Common patterns used across multiple command files:
 * - Session / active-space validation
 * - Memory / user client construction
 * - Principal / agent resolution
 * - Error handling
 */
import { homedir } from "node:os";
import * as clack from "@clack/prompts";
import type { MemoryClient, UserClient } from "./client.ts";
import { createMemoryClient, createUserClient, RpcError } from "./client.ts";
import {
  clearTokens,
  type ResolvedCredentials,
  resolveAgent,
} from "./credentials.ts";
import type { OutputFormat } from "./output.ts";
import { output } from "./output.ts";
import { memoryBearer, userBearer } from "./session.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Ensure a *real session* is present (a `me login` token, not an api key).
 * Exits with an error if not.
 *
 * Reserved for operations a key may never perform regardless of endpoint —
 * minting/revoking api keys (`apiKey.create`/`delete`): "keys can't mint keys".
 * The server enforces this too (`denyApiKeyCaller`); this is the CLI-side
 * fail-fast. Every other command takes either credential — use {@link requireAuth}.
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
 * Ensure the caller can authenticate. Exits with an error if not.
 *
 * Both RPC endpoints accept either bearer: an api key (ME_API_KEY — a user PAT
 * or an agent key) or a logged-in human session. This is the gate for every
 * command except api-key mint/revoke (see {@link requireSession}). The server
 * decides what a given credential may do (e.g. it 403s an agent key on the user
 * RPC); the CLI only checks that *some* credential is present.
 */
export function requireAuth(
  creds: ResolvedCredentials,
  fmt: OutputFormat,
): void {
  if (!creds.apiKey && !creds.loggedIn) {
    const msg = "Not authenticated. Run 'me login', or set ME_API_KEY.";
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
 * Build a user client (/api/v1/user/rpc). Call {@link requireAuth} first (or
 * {@link requireSession} for key mint/revoke). The bearer is the api key when
 * set (ME_API_KEY, a user PAT, static) else the human's OAuth access token,
 * resolved (and refreshed) lazily per call via {@link userBearer}.
 */
export function buildUserClient(creds: ResolvedCredentials): UserClient {
  return createUserClient({
    url: creds.server,
    ...userBearer(creds.server, creds.apiKey),
  });
}

/**
 * Build a memory client (bearer + active space, /api/v1/memory/rpc). Call
 * {@link requireAuth} and {@link requireSpace} first so a bearer and a space are
 * present. The bearer is the api key when set (ME_API_KEY, static), else the
 * human's OAuth access token (refreshed by {@link memoryBearer}) — the memory
 * endpoint accepts either, and this mirrors `me mcp`'s precedence.
 */
export function buildMemoryClient(
  creds: ResolvedCredentials & { activeSpace: string },
  globalOpts?: { agent?: string | boolean },
): MemoryClient {
  return createMemoryClient({
    url: creds.server,
    ...memoryBearer(creds.server, creds.apiKey),
    space: creds.activeSpace,
    // Act as an owned agent (X-Me-Agent) when `--agent`/`ME_AGENT` is set.
    agent: resolveAgent(globalOpts?.agent),
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
 * Resolve a space *member* (user or agent) to its id, by UUIDv7 or name. Like
 * {@link resolveSpacePrincipalId} but excludes groups — for call sites where a
 * group is never a valid target (e.g. group membership: groups are not
 * nestable). A bare name that matches only a group yields a precise error.
 * Exits with an actionable error on miss / ambiguity.
 *
 * A group passed by *id* is not caught here (we don't round-trip to classify a
 * UUID); the server's add_group_member guard rejects it with a clear message.
 */
export async function resolveSpaceMemberId(
  memory: MemoryClient,
  input: string,
  fmt: OutputFormat,
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;

  const { principals } = await memory.principal.resolve({ name: input });
  const members = principals.filter((p) => p.kind !== "g");

  if (members.length === 1 && members[0]) return members[0].id;

  if (members.length === 0) {
    const onlyGroup = principals.some((p) => p.kind === "g");
    const msg = onlyGroup
      ? `'${input}' is a group, not a member — groups can't be group members.`
      : `No member named '${input}' in this space.`;
    if (fmt === "text") {
      clack.log.error(msg);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  const msg = `Multiple members named '${input}'. Use the id instead:`;
  if (fmt === "text") {
    clack.log.error(msg);
    for (const m of members) console.log(`  ${m.name} (${m.kind}) — ${m.id}`);
  } else {
    output({ error: msg, matches: members }, fmt, () => {});
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

/** POSIX-quote a single argv token unless it is already a shell-safe bareword. */
function shellQuoteArg(token: string): string {
  if (/^[A-Za-z0-9_,.:/=@%+-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Diagnose a tree filter/path that the shell mangled before it reached us.
 *
 * The user-facing home shortcut is a leading `~` (`~/notes` → the caller's
 * memory home). But an *unquoted* `~` is expanded by the shell, not us: zsh/bash
 * turn `~/notes` into `$HOME/notes` and `~notes` into a lookup of user `notes`'s
 * home. So `me search --tree ~/notes` arrives here as `--tree /Users/me/notes`,
 * which normalizes to the ltree filter `Users.me.notes` and silently matches
 * nothing — exactly when the caller meant their home and should have quoted it.
 *
 * Given a tree value *as it arrived in argv*, return a one-line hint nudging the
 * caller to quote `~`, but only when the value is the caller's filesystem home
 * or a child of it (the tell-tale of `~` expansion). A real memory tree path is
 * never an absolute filesystem path, so this never fires on a legitimate filter.
 * Returns null otherwise. Call it only on a zero-result path: a non-null return
 * then means "no matches AND the filter looks shell-expanded".
 *
 * The suggestion is the *full command* as typed, with the shell-expanded home
 * token swapped for the quoted `~` form (and any other arg quoted as needed) so
 * it's copy-pasteable. `argv` (post-expansion, defaulting to `process.argv` —
 * user args at index 2, matching the rest of this CLI) and `home` are injectable
 * for testing.
 */
export function shellTildeExpansionHint(
  rawTree: string | undefined,
  argv: readonly string[] = process.argv,
  home: string = homedir(),
): string | null {
  if (!rawTree || !home || home === "/") return null;
  if (rawTree !== home && !rawTree.startsWith(`${home}/`)) return null;
  const suggestion = `~${rawTree.slice(home.length)}`; // "~" or "~/notes"
  const command = argv
    .slice(2)
    .map((arg) => (arg === rawTree ? `'${suggestion}'` : shellQuoteArg(arg)))
    .join(" ");
  return `Hint: your shell may have expanded '~'. Try: me ${command}`;
}

/**
 * Detect an authentication error from the server (HTTP 401 / `UNAUTHORIZED`).
 */
function isUnauthorized(error: unknown): boolean {
  return isAppErrorCode(error, "UNAUTHORIZED");
}

/**
 * Which credential surface a command authenticates against — drives the
 * `UNAUTHORIZED` guidance:
 *   - `account`: a user-RPC call (e.g. whoami, agent.*, apiKey.*, space.*). A 401 here
 *     is unambiguously a credential problem.
 *   - `space`: a memory-RPC call (e.g. group.*, access.*, memory.*, principal.*, grant.*, invite.*). A 401 here is
 *     a bad credential and for an unknown/unset space (it resolves the space
 *     before validating the credential, and keeps the message generic to avoid
 *     space enumeration). So the message must mention the space, and we must not
 *     clear a session token over what may just be a stale active space.
 */
export type AuthScope = "account" | "space";

/**
 * Classify an `UNAUTHORIZED` RPC error into an actionable message and whether the
 * stored session token should be cleared. Returns `null` for any other error, so
 * the caller falls back to the raw server message.
 *
 * The CLI can't tell a bad credential from an unknown space apart on the wire
 * (both are a generic 401), so the guidance is tailored by *credential type* and
 * *command scope* instead:
 *   - api key (ME_API_KEY): never a session, so never "run me login" and never
 *     clear a token. Point at ME_API_KEY (and, for space commands, the space).
 *   - session: only the account-scoped 401 is a true session expiry (clear the
 *     token, prompt re-login). A space-scoped 401 is ambiguous — keep the token
 *     and mention both the space and a possible re-login.
 */
export function describeAuthError(
  error: unknown,
  creds: ResolvedCredentials,
  scope: AuthScope,
): { message: string; clearSession: boolean } | null {
  if (!isUnauthorized(error)) return null;

  const space = creds.activeSpace ? ` '${creds.activeSpace}'` : "";

  if (creds.apiKey) {
    // Api-key auth — there is no session to expire or clear.
    const message =
      scope === "space"
        ? `Not authorized. Check that ME_API_KEY is valid, and that the active space${space} exists and is accessible — run 'me space list'.`
        : "Not authorized. Your ME_API_KEY is invalid or expired.";
    return { message, clearSession: false };
  }

  if (scope === "space") {
    // Ambiguous: a bad space slug looks identical to an expired session. Don't
    // clear the token over a stale active space.
    return {
      message: `Not authorized. The active space${space} may not exist or be accessible (run 'me space list'), or your login may have expired (run 'me login').`,
      clearSession: false,
    };
  }

  // Account-scoped session call — a genuine session expiry.
  return {
    message: "Session expired. Run 'me login' to sign in again.",
    clearSession: true,
  };
}

/**
 * Handle an error from an RPC call. Formats per output mode and exits.
 *
 * Pass `opts.creds` for commands that authenticate (every RPC command). On an
 * `UNAUTHORIZED` the message is tailored by credential type and `opts.scope`
 * (default `account`) — see {@link describeAuthError}. A genuine session expiry
 * (account-scoped, session auth) clears the stored token so the next command
 * says "Not logged in"; api-key auth and ambiguous space-scoped 401s leave it
 * intact.
 */
export function handleError(
  error: unknown,
  fmt: OutputFormat,
  opts?: { creds?: ResolvedCredentials; scope?: AuthScope },
): never {
  let msg =
    error instanceof RpcError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  let code: string | undefined;

  if (opts?.creds) {
    const auth = describeAuthError(error, opts.creds, opts.scope ?? "account");
    if (auth) {
      if (auth.clearSession) clearTokens(opts.creds.server);
      msg = auth.message;
      code = "UNAUTHORIZED";
    }
  }

  if (fmt === "text") {
    clack.log.error(msg);
  } else {
    output(code ? { error: msg, code } : { error: msg }, fmt, () => {});
  }
  process.exit(1);
}
