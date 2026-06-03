/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * User-scoped, session-only: it resolves the calling human (a user principal)
 * from a session token. Api keys are agent credentials and do not authenticate
 * here (agents can't manage agents), so an api-key token simply fails session
 * validation → 401.
 */
import type { AuthStore } from "@memory.build/auth";
import { debug, span } from "@pydantic/logfire-node";
import { unauthorized } from "../util/response";
import { extractBearerToken } from "./authenticate";

export interface UserAuthContext {
  type: "user";
  /** The authenticated user id (== the core user-principal id). */
  userId: string;
}

export type UserAuthResult =
  | { ok: true; context: UserAuthContext }
  | { ok: false; error: Response };

export async function authenticateUser(
  request: Request,
  auth: AuthStore,
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      const token = extractBearerToken(request);
      if (!token) {
        debug("user auth failed: missing Authorization header");
        return {
          ok: false,
          error: unauthorized("Missing or invalid Authorization header"),
        };
      }
      const session = await auth.validateSession(token);
      if (!session) {
        debug("user auth failed: invalid or expired session");
        return { ok: false, error: unauthorized("Invalid or expired session") };
      }
      debug("user auth succeeded", { userId: session.userId });
      return { ok: true, context: { type: "user", userId: session.userId } };
    },
  });
}
