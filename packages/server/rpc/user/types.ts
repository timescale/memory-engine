/**
 * User RPC context — populated by authenticateUser. User-scoped (no space):
 * the calling user manages their own global service accounts (agents).
 */
import type { CoreStore } from "@memory.build/engine/core";
import type { Sql } from "postgres";
import type { HandlerContext } from "../types";

export interface UserRpcContext extends HandlerContext {
  /** Core control-plane store. */
  core: CoreStore;
  /** The authenticated user id (== the core user-principal id). */
  userId: string;
  /** The caller's email (from the better-auth session) — powers whoami. */
  email: string;
  /** The caller's display name (from the better-auth session). */
  name: string;
  /** New-model pool — for transactional provisioning (space.create). */
  db: Sql;
  /** The core control-plane schema name. */
  coreSchema: string;
  /**
   * True when the caller authenticated with an api key (a user PAT) rather than
   * a session / OAuth token. Gates the credential-management ops: a key can't
   * mint or revoke keys (preserves revocability), so apiKey.create/delete reject
   * a key-authenticated caller.
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
