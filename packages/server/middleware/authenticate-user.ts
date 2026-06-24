/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * User-scoped: resolves the calling human (a user principal) from one of three
 * credentials — an OAuth access token (CLI/MCP), the browser cookie session, or
 * the user's own api key (a personal access token, for headless/CLI use). Only
 * the caller's OWN (kind 'u') key is admitted: an AGENT key is barred here
 * (agents can't manage the account) → 403.
 */
import { type CoreStore, parseApiKey } from "@memory.build/engine/core";
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
  /**
   * True when authenticated by an api key (a user PAT) rather than a session /
   * OAuth token. The handler layer uses this to keep key mint/revoke
   * session-only (a key can't manage keys).
   */
  viaApiKey: boolean;
}

export type UserAuthResult =
  | { ok: true; context: UserAuthContext }
  | { ok: false; error: Response };

export async function authenticateUser(
  request: Request,
  betterAuth: Auth,
  verifyOAuthToken: VerifyOAuthAccessToken,
  core: CoreStore,
  allowedOrigins: string[],
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      const bearer = extractBearerToken(request);
      if (bearer) {
        // A user PAT (api key). Only the caller's OWN (kind 'u') principal is
        // admitted here; an agent key is a valid credential but not for the user
        // API (agents can't manage the account) → 403. An api key is never an
        // OAuth token, so this branch always returns.
        const parsed = parseApiKey(bearer);
        if (parsed) {
          const validated = await core.validateApiKey(
            parsed.lookupId,
            parsed.secret,
          );
          if (!validated) {
            debug("user auth failed: invalid api key");
            return {
              ok: false,
              error: unauthorized("Invalid or expired token"),
            };
          }
          const principal = await core.getPrincipal(validated.memberId);
          if (!principal || principal.kind !== "u") {
            debug("user auth failed: agent api key on the user RPC");
            return {
              ok: false,
              error: forbidden(
                "Agent API keys can't access the user API; use a session or a user key.",
              ),
            };
          }
          debug("user auth succeeded (user pat)", { userId: principal.id });
          return {
            ok: true,
            context: {
              type: "user",
              userId: principal.id,
              // The core user principal's name is the email; the display name
              // lives on auth.users (not fetched on the key path).
              email: principal.name,
              name: principal.name,
              // We don't carry the verified flag on the key path → the
              // email-keyed redemption step is skipped for PAT calls (it runs on
              // the user's interactive logins instead).
              emailVerified: false,
              viaApiKey: true,
            },
          };
        }

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
            viaApiKey: false,
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
          viaApiKey: false,
        },
      };
    },
  });
}
