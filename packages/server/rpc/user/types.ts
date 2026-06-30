/**
 * User RPC context — populated by authenticateUser. Account-scoped (no space):
 * identity (`whoami`) and space discovery (`space.list`) for any authenticated
 * principal, plus the account-management surface (agents, api keys, space
 * lifecycle) which is user-only — see {@link requireUserCaller}.
 */
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import { AppError } from "../errors";
import type { HandlerContext } from "../types";

export interface UserRpcContext extends HandlerContext {
  /** Core control-plane store. */
  core: CoreStore;
  /** The authenticated principal's kind: a user ("u") or an agent ("a"). */
  kind: "u" | "a";
  /** The authenticated principal id (a user-principal id, or an agent's). */
  userId: string;
  /** The caller's email (powers whoami); null for an agent (no email). */
  email: string | null;
  /**
   * Whether the identity provider verified the email. Gates the email-keyed
   * invitee methods (`invite.*`): a caller may only act on invitations addressed
   * to their own verified address. Always false for an agent (no email).
   */
  emailVerified: boolean;
  /**
   * The caller's name: a human display name from a session / OAuth token, or
   * the core principal's name on the api-key path — the user's email for a user
   * PAT, the agent's name for an agent.
   */
  name: string;
  /** New-model pool — for transactional provisioning (space.create). */
  db: Sql;
  /** The core control-plane schema name. */
  coreSchema: string;
  /**
   * True when the caller authenticated with an api key (a user PAT or an agent
   * key) rather than a session / OAuth token. Gates the credential-management
   * ops: a key can't mint or revoke keys (preserves revocability), so
   * apiKey.create/delete reject a key-authenticated caller.
   */
  viaApiKey: boolean;
}

export function isUserRpcContext(ctx: HandlerContext): ctx is UserRpcContext {
  return (
    "core" in ctx &&
    typeof ctx.core === "object" &&
    ctx.core !== null &&
    "userId" in ctx &&
    typeof ctx.userId === "string"
  );
}

export function assertUserRpcContext(
  ctx: HandlerContext,
): asserts ctx is UserRpcContext {
  if (!isUserRpcContext(ctx)) {
    throw new Error("User context not initialized (authentication required)");
  }
}

/**
 * Reject a non-user (agent) caller from an account-management method.
 *
 * The user RPC admits any authenticated principal so agent keys can run the
 * account-scoped *reads* (`whoami`, `space.list`) — but managing the account
 * (agents, api keys, space lifecycle) is user-only: an agent is owned by a user,
 * it doesn't own agents, spaces, or keys, and it is never an admin. The user-RPC
 * gate (`gateAgentAccess` in ./index) calls this for every method outside its
 * allow-list, so the denial is default-on and lives in one place rather than
 * relying on each handler to incidentally reject an agent.
 */
export function requireUserCaller(ctx: UserRpcContext): void {
  if (ctx.kind !== "u") {
    throw new AppError(
      "FORBIDDEN",
      "This action is user-only; an agent API key can't manage the account.",
    );
  }
}
