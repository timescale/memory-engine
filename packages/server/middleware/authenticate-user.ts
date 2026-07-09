/**
 * Authentication for the user RPC (`/api/v1/user/rpc`).
 *
 * Resolves the calling principal from one of three credentials — an OAuth access
 * token (CLI/MCP), the browser cookie session, or an api key (a user PAT or an
 * agent key, for headless/CLI use). Authentication establishes *who*; it no
 * longer doubles as the authorization gate. Any authenticated principal is
 * admitted here so the account-scoped *reads* (`whoami`, `space.list`) work for
 * an agent acting with `ME_API_KEY`; the account-*management* methods stay
 * user-only, enforced by the user-RPC gate's allow-list (`gateAgentAccess` +
 * `requireUserCaller`). Sessions / OAuth tokens are always users; an api key
 * carries its principal's real kind.
 */
import { type CoreStore, parseApiKey } from "@memory.build/engine/core";
import { AS_AGENT_HEADER } from "@memory.build/protocol/headers";
import { debug, span } from "@pydantic/logfire-node";
import type {
  Auth,
  GetUserEmailVerified,
  VerifyOAuthAccessToken,
} from "../auth/betterauth";
import { error, forbidden, unauthorized } from "../util/response";
import { resolveOwnedAgent } from "./act-as-agent";
import { extractBearerToken, passesCsrfCheck } from "./authenticate";

export interface UserAuthContext {
  type: "user";
  /** The authenticated principal's kind: user, agent, or service account. */
  kind: "u" | "a" | "s";
  /** The authenticated principal id (a user-principal id, or an agent's). */
  userId: string;
  /** The user's email (powers whoami + lazy provisioning); null for an agent. */
  email: string | null;
  /**
   * The principal's name. From a session / OAuth token this is the human's
   * display name; on the api-key path it's the core principal's name — which is
   * the user's email for a user PAT, or the agent's name for an agent.
   */
  name: string;
  /**
   * Whether the identity provider verified the email. Gates email-keyed
   * provisioning steps (invitation redemption) — invitations are addressed by
   * email, so an unverified address must not auto-join its invited spaces.
   * Always false for an agent (no email).
   */
  emailVerified: boolean;
  /**
   * True when authenticated by an api key (a user PAT or an agent key) rather
   * than a session / OAuth token. The handler layer uses this to keep key
   * mint/revoke session-only (a key can't manage keys).
   */
  viaApiKey: boolean;
  /**
   * When a human is acting as one of their own agents (via `X-Me-As-Agent`),
   * the human's principal id; null otherwise. Observability only — never gates
   * authorization (which reads `kind` / `userId`, both already switched to the
   * agent).
   */
  authenticatedAs: string | null;
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
      const result = await resolvePrincipal();
      if (!result.ok) return result;
      // Act-as-agent switch: a human caller (kind 'u') may run as one of their
      // own agents via `X-Me-As-Agent`. An agent key (kind 'a') already IS an
      // agent → the header is ignored (parity precedence). On a match the whole
      // context is overwritten to the agent, reusing the agent-key semantics so
      // the `AGENT_ALLOWED` allow-list constrains it automatically.
      return applyActAsAgent(result, request, core);
    },
  });

  async function resolvePrincipal(): Promise<UserAuthResult> {
    const bearer = extractBearerToken(request);
    if (bearer) {
      // An api key — a user PAT (kind 'u'), agent key (kind 'a'), or service
      // account key (kind 's'). All are admitted; per-method handlers authorize
      // what each may do (non-users get `whoami` / `space.list`, nothing that
      // manages the account).
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
        const principal = await core.getPrincipal(validated.memberId);
        // A key only ever resolves to a credential-bearing principal (groups
        // hold no key); a missing principal means a member torn down under a
        // live key.
        if (!principal || principal.kind === "g") {
          debug("user auth failed: api key resolves to no usable principal");
          return {
            ok: false,
            error: unauthorized("Invalid or expired token"),
          };
        }
        const isUser = principal.kind === "u";
        debug("user auth succeeded (api key)", {
          userId: principal.id,
          kind: principal.kind,
        });
        return {
          ok: true,
          context: {
            type: "user",
            kind: principal.kind,
            userId: principal.id,
            // For a user the core principal's name IS the email (the display
            // name lives on auth.users, not fetched on the key path); agents and
            // service accounts have no email — their names are display names.
            email: isUser ? principal.name : null,
            name: principal.name,
            // For a user PAT, carry the real verified flag (the same fact a
            // session reports), so it behaves like any other credential —
            // including the email-keyed redemption step. An agent has no
            // email to verify. A key's only carve-out is that it can't
            // mint/revoke keys (enforced at the handler layer).
            emailVerified: isUser
              ? await getUserEmailVerified(principal.id)
              : false,
            viaApiKey: true,
            authenticatedAs: null,
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
          kind: "u",
          userId: verified.userId,
          email: verified.email,
          name: verified.name,
          emailVerified: verified.emailVerified,
          viaApiKey: false,
          authenticatedAs: null,
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
        authenticatedAs: null,
      },
    };
  }

  /**
   * Apply the `X-Me-As-Agent` switch to a resolved human context. When the
   * bearer is a human (`kind === 'u'`) and the header unambiguously names one
   * of their owned agents by id or case-insensitive name, overwrite the context
   * to that agent — `kind='a'`, `userId=agent.id`, `email=null`, `name=agent.name`,
   * `emailVerified=false`, `viaApiKey=true` (Decision B: strict agent-key
   * parity), recording the human as `authenticatedAs` for observability. An
   * agent key (`kind === 'a'`) already IS an agent, so the header is ignored. A
   * header value that isn't an owned agent → 403 `INVALID_AGENT`.
   */
  async function applyActAsAgent(
    result: { ok: true; context: UserAuthContext },
    req: Request,
    coreStore: CoreStore,
  ): Promise<UserAuthResult> {
    const asAgent = req.headers.get(AS_AGENT_HEADER);
    if (!asAgent || result.context.kind !== "u") return result;

    const human = result.context.userId;
    const agents = await coreStore.listAgents(human);
    const resolved = resolveOwnedAgent(agents, asAgent);
    if (resolved.kind !== "found") {
      debug("user auth failed: X-Me-As-Agent not an owned agent", {
        userId: human,
        asAgent,
        reason: resolved.kind,
      });
      return {
        ok: false,
        error: error(
          resolved.kind === "ambiguous"
            ? `X-Me-As-Agent '${asAgent}' matches multiple agents you own; rename the conflicting agent`
            : `X-Me-As-Agent '${asAgent}' is not an agent you own`,
          403,
          "INVALID_AGENT",
        ),
      };
    }
    const { agent } = resolved;
    debug("user auth act-as-agent", { userId: human, agentId: agent.id });
    return {
      ok: true,
      context: {
        ...result.context,
        kind: "a",
        userId: agent.id,
        email: null,
        name: agent.name,
        emailVerified: false,
        viaApiKey: true,
        authenticatedAs: human,
      },
    };
  }
}
