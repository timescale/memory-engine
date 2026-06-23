/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * User-scoped, session-only: it resolves the calling human (a user principal)
 * from a better-auth session (a signed bearer token or the browser cookie). Api
 * keys are agent credentials and do not authenticate here (agents can't manage
 * agents), so an api-key token simply fails session validation → 401.
 */
import { debug, span } from "@pydantic/logfire-node";
import type { Auth } from "../auth/betterauth";
import { forbidden, unauthorized } from "../util/response";
import { extractBearerToken, passesCsrfCheck } from "./authenticate";

export interface UserAuthContext {
  type: "user";
  /** The authenticated user id (== the core user-principal id). */
  userId: string;
  /** The user's email (from the session — powers whoami without a DB hit). */
  email: string;
  /** The user's display name. */
  name: string;
}

export type UserAuthResult =
  | { ok: true; context: UserAuthContext }
  | { ok: false; error: Response };

export async function authenticateUser(
  request: Request,
  betterAuth: Auth,
  allowedOrigins: string[],
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      // A credential must be present: a Bearer header (session or, here, a
      // never-valid api key) or any cookie (better-auth reads its own).
      const bearer = extractBearerToken(request);
      const hasCookie = request.headers.get("cookie") !== null;
      if (!bearer && !hasCookie) {
        debug("user auth failed: missing credential");
        return {
          ok: false,
          error: unauthorized(
            "Authentication required (Authorization header or session cookie)",
          ),
        };
      }
      // CSRF: an ambient cookie credential (no Bearer header) must come from an
      // allowed origin. Header credentials can't be forged cross-site.
      if (!bearer && !passesCsrfCheck(request, allowedOrigins)) {
        debug("user auth failed: cookie request failed CSRF origin check");
        return { ok: false, error: forbidden("Cross-origin request rejected") };
      }
      // better-auth reads the credential (signed bearer or cookie) from headers.
      const session = await betterAuth.api.getSession({
        headers: request.headers,
      });
      if (!session) {
        debug("user auth failed: missing or invalid session");
        return {
          ok: false,
          error: unauthorized("Invalid or expired session"),
        };
      }
      const { user } = session;
      debug("user auth succeeded", { userId: user.id });
      return {
        ok: true,
        context: {
          type: "user",
          userId: user.id,
          email: user.email,
          name: user.name,
        },
      };
    },
  });
}
