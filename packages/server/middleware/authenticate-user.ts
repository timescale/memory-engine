/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * User-scoped: resolves the calling human (a user principal) from either an
 * OAuth access token (the CLI / MCP bearer) or the browser cookie session. Api
 * keys are agent credentials and do not authenticate here (agents can't manage
 * agents) — an api-key bearer isn't a valid OAuth access token → 401.
 */
import { debug, span } from "@pydantic/logfire-node";
import type { Auth, VerifyOAuthAccessToken } from "../auth/betterauth";
import { forbidden, unauthorized } from "../util/response";
import { extractBearerToken, passesCsrfCheck } from "./authenticate";

export interface UserAuthContext {
  type: "user";
  /** The authenticated user id (== the core user-principal id). */
  userId: string;
  /** The user's email (powers whoami + lazy provisioning). */
  email: string;
  /** The user's display name. */
  name: string;
  /**
   * Whether the identity provider verified the email. Gates email-keyed
   * provisioning steps (invitation redemption) — invitations are addressed by
   * email, so an unverified address must not auto-join its invited spaces.
   */
  emailVerified: boolean;
}

export type UserAuthResult =
  | { ok: true; context: UserAuthContext }
  | { ok: false; error: Response };

export async function authenticateUser(
  request: Request,
  betterAuth: Auth,
  verifyOAuthToken: VerifyOAuthAccessToken,
  allowedOrigins: string[],
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      const bearer = extractBearerToken(request);
      if (bearer) {
        // OAuth access token (CLI / MCP). One lookup yields user + identity.
        const verified = await verifyOAuthToken(bearer);
        if (!verified) {
          debug("user auth failed: invalid or expired OAuth access token");
          return {
            ok: false,
            error: unauthorized("Invalid or expired token"),
          };
        }
        debug("user auth succeeded (oauth)", { userId: verified.userId });
        return {
          ok: true,
          context: {
            type: "user",
            userId: verified.userId,
            email: verified.email,
            name: verified.name,
            emailVerified: verified.emailVerified,
          },
        };
      }

      // Browser cookie session. CSRF gates the ambient cookie credential.
      if (request.headers.get("cookie") === null) {
        debug("user auth failed: missing credential");
        return {
          ok: false,
          error: unauthorized(
            "Authentication required (Authorization header or session cookie)",
          ),
        };
      }
      if (!passesCsrfCheck(request, allowedOrigins)) {
        debug("user auth failed: cookie request failed CSRF origin check");
        return { ok: false, error: forbidden("Cross-origin request rejected") };
      }
      const session = await betterAuth.api.getSession({
        headers: request.headers,
      });
      if (!session) {
        debug("user auth failed: missing or invalid session");
        return { ok: false, error: unauthorized("Invalid or expired session") };
      }
      const { user } = session;
      debug("user auth succeeded (cookie)", { userId: user.id });
      return {
        ok: true,
        context: {
          type: "user",
          userId: user.id,
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
        },
      };
    },
  });
}
