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
import { forbidden, unauthorized } from "../util/response";
import { extractSessionCredential, passesCsrfCheck } from "./authenticate";

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
  allowedOrigins: string[],
  cookieSecure: boolean,
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      const credential = extractSessionCredential(request, cookieSecure);
      if (!credential) {
        debug("user auth failed: missing credential");
        return {
          ok: false,
          error: unauthorized(
            "Authentication required (Authorization header or session cookie)",
          ),
        };
      }
      // CSRF: ambient cookie credentials must come from an allowed origin.
      if (
        credential.source === "cookie" &&
        !passesCsrfCheck(request, allowedOrigins)
      ) {
        debug("user auth failed: cookie request failed CSRF origin check");
        return { ok: false, error: forbidden("Cross-origin request rejected") };
      }
      const session = await auth.validateSession(credential.token);
      if (!session) {
        debug("user auth failed: invalid or expired session");
        return { ok: false, error: unauthorized("Invalid or expired session") };
      }
      debug("user auth succeeded", { userId: session.userId });
      return { ok: true, context: { type: "user", userId: session.userId } };
    },
  });
}
