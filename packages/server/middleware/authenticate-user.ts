/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * Resolves the calling principal from one of these credentials — an OAuth access
 * token (CLI/MCP), a signed better-auth session token presented as a bearer (the
 * device-authorization flow, via the `bearer` plugin), the browser cookie
 * session, or an api key (a user PAT or a service-account key). Authentication
 * establishes *who*; the user-RPC gate limits service accounts to `whoami` and
 * `space.list` while keeping account-management methods user-only. Sessions /
 * OAuth tokens are always users; an api key carries its principal's real kind.
 */
import { type CoreStore, parseApiKey } from "@memory.build/engine/core";
import { debug, span } from "@pydantic/logfire-node";
import type {
  Auth,
  GetUserEmailVerified,
  VerifyOAuthAccessToken,
} from "../auth/betterauth";
import { forbidden, unauthorized } from "../util/response";
import { recordApiKeyUse } from "./api-key-usage";
import {
  bearerOnlyHeaders,
  extractBearerToken,
  passesCsrfCheck,
} from "./authenticate";

export interface UserAuthContext {
  type: "user";
  /** The authenticated principal's kind: user or service account. */
  kind: "u" | "s";
  /** The authenticated principal id (a user-principal or service-account id). */
  userId: string;
  /** The user's email (powers whoami + lazy provisioning); null for non-users. */
  email: string | null;
  /**
   * The principal's name. From a session / OAuth token this is the human's
   * display name; on the api-key path it's the core principal's name — which is
   * the user's email for a user PAT, or the service-account handle.
   */
  name: string;
  /**
   * Whether the identity provider verified the email. Gates email-keyed
   * provisioning steps (invitation redemption) — invitations are addressed by
   * email, so an unverified address must not auto-join its invited spaces.
   * Always false for service accounts (which have no email).
   */
  emailVerified: boolean;
  /**
   * True when authenticated by an api key (a user PAT or service-account key)
   * rather than a session / OAuth token. The handler layer
   * uses this to keep key mint/revoke session-only (a key can't manage keys).
   */
  viaApiKey: boolean;
  /** API key id when authenticated by an API key; null for session/OAuth. */
  apiKeyId: string | null;
  /** Whether the authenticated API key carries access declarations. */
  apiKeyRestricted: boolean;
}

export type UserAuthResult =
  | { ok: true; context: UserAuthContext }
  | { ok: false; error: Response };

export async function authenticateUser(
  request: Request,
  betterAuth: Auth,
  verifyOAuthToken: VerifyOAuthAccessToken,
  getUserEmailVerified: GetUserEmailVerified,
  core: CoreStore,
  allowedOrigins: string[],
): Promise<UserAuthResult> {
  return span("auth.user", {
    attributes: { "auth.type": "user" },
    callback: async () => {
      return resolvePrincipal();
    },
  });

  async function resolvePrincipal(): Promise<UserAuthResult> {
    const bearer = extractBearerToken(request);
    if (bearer) {
      // An api key — a user PAT (kind 'u') or service-account key (kind 's').
      // Both are admitted; per-method handlers authorize what each may do.
      // An api key is never an OAuth token, so this branch always returns.
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
        // validate_api_key already joined core.principal and returns the kind +
        // name, so there's no second lookup. An api key only ever belongs to a
        // member principal (user or service account); accept those
        // explicitly and reject anything else rather than trusting the DB's text
        // `kind`.
        if (validated.kind !== "u" && validated.kind !== "s") {
          debug("user auth failed: api key principal is not a member kind", {
            kind: validated.kind,
          });
          return {
            ok: false,
            error: unauthorized("Invalid or expired token"),
          };
        }
        await recordApiKeyUse(core, validated.apiKeyId);
        const isUser = validated.kind === "u";
        debug("user auth succeeded (api key)", {
          userId: validated.memberId,
          kind: validated.kind,
        });
        return {
          ok: true,
          context: {
            type: "user",
            kind: validated.kind,
            userId: validated.memberId,
            // For a user the core principal's name IS the email (the display
            // name lives on auth.users, not fetched on the key path); service
            // accounts have no email — their names are display names.
            email: isUser ? validated.name : null,
            name: validated.name,
            // For a user PAT, carry the real verified flag (the same fact a
            // session reports), so it behaves like any other credential —
            // including the email-keyed redemption step. Service accounts have
            // no email to verify. A key's only carve-out is that it can't
            // mint/revoke keys (enforced at the handler layer).
            emailVerified: isUser
              ? await getUserEmailVerified(validated.memberId)
              : false,
            viaApiKey: true,
            apiKeyId: validated.apiKeyId,
            apiKeyRestricted: validated.restricted,
          },
        };
      }

      // OAuth access token (CLI / MCP). One lookup yields user + identity.
      const verified = await verifyOAuthToken(bearer);
      if (verified) {
        debug("user auth succeeded (oauth)", { userId: verified.userId });
        return {
          ok: true,
          context: {
            type: "user",
            kind: "u",
            userId: verified.userId,
            email: verified.email,
            name: verified.name,
            emailVerified: verified.emailVerified,
            viaApiKey: false,
            apiKeyId: null,
            apiKeyRestricted: false,
          },
        };
      }

      // Not an OAuth token — try a signed better-auth session token presented as
      // a bearer (the device-authorization flow's credential, resolved via the
      // `bearer` plugin). A bearer is an explicit, non-ambient credential, so
      // this deliberately skips the cookie CSRF gate (same as the OAuth path).
      // Pass Authorization-only headers so this can ONLY succeed via the bearer
      // token — never fall back to an ambient cookie session (which would skip
      // CSRF and blur bearer-vs-cookie precedence).
      const bearerSession = await betterAuth.api.getSession({
        headers: bearerOnlyHeaders(request),
      });
      if (!bearerSession) {
        debug(
          "user auth failed: bearer is neither a valid OAuth token nor session",
        );
        return {
          ok: false,
          error: unauthorized("Invalid or expired token"),
        };
      }
      const bearerUser = bearerSession.user;
      debug("user auth succeeded (session bearer)", { userId: bearerUser.id });
      return {
        ok: true,
        context: {
          type: "user",
          kind: "u",
          userId: bearerUser.id,
          email: bearerUser.email,
          name: bearerUser.name,
          emailVerified: bearerUser.emailVerified,
          viaApiKey: false,
          apiKeyId: null,
          apiKeyRestricted: false,
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
        kind: "u",
        userId: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        viaApiKey: false,
        apiKeyId: null,
        apiKeyRestricted: false,
      },
    };
  }
}
