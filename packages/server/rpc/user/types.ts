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
  /** The authenticated principal's kind: user, agent, or service account. */
  kind: "u" | "a" | "s";
  /** The authenticated principal id (user, agent, or service account). */
  userId: string;
  /** The caller's email (powers whoami); null for non-users. */
  email: string | null;
  /**
   * Whether the identity provider verified the email. Gates the email-keyed
   * invitee methods (`invite.*`): a caller may only act on invitations addressed
   * to their own verified address. Always false for non-users (no email).
   */
  emailVerified: boolean;
  /**
   * The caller's name: a human display name from a session / OAuth token, or
   * the core principal's name on the api-key path — the user's email for a user
   * PAT, or the principal handle for an agent/service account.
   */
  name: string;
  /** New-model pool — for transactional provisioning (space.create). */
  db: Sql;
  /** The core control-plane schema name. */
  coreSchema: string;
  /**
   * True when the caller authenticated with an api key (a user PAT, agent key,
   * or service-account key) rather than a session / OAuth token. Gates the
   * credential-management ops: a key can't mint or revoke keys (preserves
   * revocability), so apiKey.create/delete reject a key-authenticated caller.
   */
  viaApiKey: boolean;
  /**
   * When a human is acting as one of their own agents (via `X-Me-As-Agent`),
   * the human's principal id; null otherwise. Observability only — authorization
   * reads the (already switched) `kind` / `userId`.
   */
  authenticatedAs: string | null;
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
 * Reject a non-user (agent/service account) caller from an account-management method.
 *
 * The user RPC admits any authenticated principal so non-user keys can run the
 * account-scoped *reads* (`whoami`, `space.list`) — but managing the account is
 * user-only. The user-RPC gate (`gateAgentAccess` in ./index) calls this for
 * every method outside its allow-list, so the denial is default-on and lives in
 * one place rather than relying on each handler to incidentally reject a
 * non-user.
 */
export function requireUserCaller(ctx: UserRpcContext): void {
  if (ctx.kind !== "u") {
    throw new AppError(
      "FORBIDDEN",
      "This action is user-only; non-user principals can't manage the account.",
    );
  }
}
