/**
 * Authentication for the space memory RPC (`/api/v1/memory/rpc`).
 *
 * Resolves an authenticated principal and a target space into the access set
 * (`treeAccess`) that the space SQL functions consume. Two credential modes,
 * discriminated by whether the bearer token parses as an api key:
 *
 *   - api key (agent): `me.<lookupId>.<secret>` — validated against core.
 *   - human: an OAuth access token (Bearer, CLI/MCP) or a better-auth cookie
 *     session — both opaque, validated against the auth schema.
 *
 * The space is always selected by the `X-Me-Space` header (uniform for both
 * modes). `core.buildTreeAccess(principalId, space.id)` is the single
 * authorization gate: a principal with no grants in the space resolves to an
 * empty set and is denied. Api keys are global, so a key whose principal isn't a
 * member of the requested space is denied here rather than at parse time.
 */
import { slugToSchema } from "@memory.build/database";
import {
  type CoreStore,
  isLegacyApiKey,
  parseApiKey,
  type Space,
  type TreeAccess,
} from "@memory.build/engine/core";
import { type SpaceStore, spaceStore } from "@memory.build/engine/space";
import { AGENT_HEADER, SPACE_HEADER } from "@memory.build/protocol/headers";
import { debug, span } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import type { Auth, VerifyOAuthAccessToken } from "../auth/betterauth";
import { error, forbidden, unauthorized } from "../util/response";
import { extractBearerToken, passesCsrfCheck } from "./authenticate";

export { AGENT_HEADER, SPACE_HEADER };

/**
 * The authenticated principal + resolved space for a memory RPC request.
 */
export interface SpaceAuthContext {
  type: "space";
  /** Space data-plane store bound to the `me_<slug>` schema. */
  store: SpaceStore;
  /** Core control-plane store (shared; used by the management methods). */
  core: CoreStore;
  /** The resolved space. */
  space: Space;
  /** Authenticated principal id (user id for sessions, agent id for api keys). */
  principalId: string;
  /**
   * The authenticated principal's owner — non-null when it is an agent, null for
   * a user/session. Drives `~` home nesting (an agent's home lives under its
   * owner's home).
   */
  ownerId: string | null;
  /** Api key id when authenticated by api key; null for sessions. */
  apiKeyId: string | null;
  /** The principal's effective grants in this space — the access gate. */
  treeAccess: TreeAccess;
  /** Whether the principal is a space admin (principal_space.admin). */
  admin: boolean;
  /**
   * When a human acts as one of their agents via the `X-Me-Agent` header, this
   * is the *human's* id (the true authenticator), while `principalId`/`ownerId`
   * are switched to the agent. Null otherwise. Not used for authorization — only
   * observability/audit.
   */
  authenticatedAs: string | null;
}

export type SpaceAuthResult =
  | { ok: true; context: SpaceAuthContext }
  | { ok: false; error: Response };

export interface SpaceAuthDeps {
  /** Core control-plane store (on the new-model pool). */
  core: CoreStore;
  /** better-auth instance — validates the web cookie session. */
  betterAuth: Auth;
  /** Validates an OAuth access token (the CLI/MCP bearer). */
  verifyOAuthToken: VerifyOAuthAccessToken;
  /** New-model pool — used to bind the per-space data-plane store. */
  db: Sql;
  /** Origins allowed for cookie-authenticated (browser) requests — CSRF gate. */
  allowedOrigins: string[];
}

/**
 * Authenticate a memory RPC request and resolve its space access set.
 */
export async function authenticateSpace(
  request: Request,
  deps: SpaceAuthDeps,
): Promise<SpaceAuthResult> {
  return span("auth.space", {
    attributes: { "auth.type": "space" },
    callback: () => authenticateSpaceInner(request, deps),
  });
}

async function authenticateSpaceInner(
  request: Request,
  deps: SpaceAuthDeps,
): Promise<SpaceAuthResult> {
  const { core, betterAuth, db } = deps;

  // 1. A credential must be present: an Authorization Bearer (session token or
  //    api key) or any cookie (better-auth reads its own session cookie). The
  //    CSRF gate for the cookie case is applied in the session branch below.
  const bearer = extractBearerToken(request);
  const hasCookie = request.headers.get("cookie") !== null;
  if (!bearer && !hasCookie) {
    debug("space auth failed: missing credential");
    return {
      ok: false,
      error: unauthorized(
        "Authentication required (Authorization header or session cookie)",
      ),
    };
  }

  // 2. Space slug — always from the X-Me-Space header (uniform for both modes).
  const slug = request.headers.get(SPACE_HEADER);
  if (!slug) {
    debug("space auth failed: missing X-Me-Space header");
    return {
      ok: false,
      error: error(`Missing ${SPACE_HEADER} header`, 400, "MISSING_SPACE"),
    };
  }

  // 3. Resolve the space (shared step). Generic 401 to avoid space enumeration.
  const space = await core.getSpace(slug);
  if (!space) {
    debug("space auth failed: unknown space", { slug });
    return { ok: false, error: unauthorized("Invalid credentials") };
  }

  // 4. Resolve the principal — the only step that differs between modes. Api
  //    keys arrive only via the Bearer header (never a cookie).
  const parsed = bearer ? parseApiKey(bearer) : null;
  let principalId: string;
  let apiKeyId: string | null;
  // The principal's owner — set only for an agent key; drives `~` home nesting.
  let ownerId: string | null = null;

  if (parsed) {
    // Api keys are global; the space comes solely from the header. A key whose
    // principal isn't a member of this space falls through to the empty-access
    // gate below (403), not a parse-time rejection.
    const validated = await core.validateApiKey(parsed.lookupId, parsed.secret);
    if (!validated) {
      debug("space auth failed: invalid api key");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = validated.memberId;
    apiKeyId = validated.apiKeyId;
    ownerId = validated.ownerId;
  } else if (bearer && isLegacyApiKey(bearer)) {
    // A pre-global 4-part key (me.<slug>.<lookup>.<secret>). These no longer
    // authenticate; tell the operator to recreate the key rather than failing
    // with a confusing generic 401.
    debug("space auth failed: legacy 4-part api key");
    return {
      ok: false,
      error: error(
        "This API key uses the old space-scoped format (me.<slug>.<id>.<secret>) and no longer works. Recreate it with `me apikey create --agent <agent>`, then update ME_API_KEY or your MCP/plugin config.",
        401,
        "LEGACY_API_KEY",
      ),
    };
  } else if (bearer) {
    // OAuth access token (the CLI / MCP clients) — resource-server validation
    // (hashed lookup in oauth_access_token).
    const verified = await deps.verifyOAuthToken(bearer);
    if (!verified) {
      debug("space auth failed: invalid or expired OAuth access token");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = verified.userId;
    apiKeyId = null;
  } else {
    // Browser cookie session. CSRF gates the ambient cookie credential.
    if (!passesCsrfCheck(request, deps.allowedOrigins)) {
      debug("space auth failed: cookie request failed CSRF origin check");
      return { ok: false, error: forbidden("Cross-origin request rejected") };
    }
    const session = await betterAuth.api.getSession({
      headers: request.headers,
    });
    if (!session) {
      debug("space auth failed: invalid or expired session");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = session.user.id;
    apiKeyId = null;
  }

  // 4b. X-Me-Agent: a *human* can act as one of their own agents — the request
  // stays authenticated as the human but is authorized as the agent (grants
  // clamped to the human by build_tree_access → agent_tree_access). Switching
  // principalId to the agent (and ownerId to the human) makes every downstream
  // consumer — the tree_access gate, `~` home nesting, and the admin check —
  // behave exactly as if the agent had acted.
  //
  // Precedence: an agent-issued api key (typically ME_API_KEY) *trumps*
  // X-Me-Agent. The `ownerId === null` guard is the whole mechanism: only a
  // human credential (a session or a user PAT) has a null owner, whereas an
  // agent key resolves via validate_api_key to owner_id = the agent's owner
  // (non-null). So when the bearer is already an agent, the header is skipped
  // entirely — not resolved, not validated, never a 403 — because that key *is*
  // the acting agent and there is nothing to switch. (The header still rides
  // along on the request; the CLI can't tell an agent key from a user PAT
  // locally, so the server, which can, is the sole arbiter of this precedence.)
  let authenticatedAs: string | null = null;
  const agentHeader = request.headers.get(AGENT_HEADER);
  if (agentHeader && ownerId === null) {
    // ownerId === null ⇒ the bearer is a human (session or user PAT), not an
    // agent key. Resolve the header value (agent id or name) against the
    // caller's own agents — this is the ownership check.
    const owned = await core.listAgents(principalId);
    const agent =
      owned.find((a) => a.id === agentHeader) ??
      owned.find((a) => a.name === agentHeader) ??
      null;
    if (!agent) {
      debug("space auth failed: X-Me-Agent not an owned agent", {
        slug,
        agentHeader,
      });
      return {
        ok: false,
        error: error(
          `X-Me-Agent '${agentHeader}' is not an agent you own`,
          403,
          "INVALID_AGENT",
        ),
      };
    }
    authenticatedAs = principalId; // the true human authenticator
    ownerId = principalId; // the human owns the agent
    principalId = agent.id; // authorize as the agent
  }

  // 5. The single membership / authorization gate. An empty set means the
  // principal has no grants in this space (incl. a wrong-space api key) — deny.
  const treeAccess = await core.buildTreeAccess(principalId, space.id);
  if (treeAccess.length === 0) {
    debug("space auth failed: no access in space", { slug, principalId });
    return { ok: false, error: forbidden("No access to this space") };
  }

  // 6. Bind the data-plane store to this space's schema, and resolve whether
  // the principal is a space admin (membership-level management authority).
  const store = spaceStore(db, slugToSchema(space.slug));
  const admin = await core.isSpaceAdmin(principalId, space.id);

  debug("space auth succeeded", {
    slug,
    principalId,
    byApiKey: apiKeyId !== null,
    actingAsAgent: authenticatedAs !== null,
  });
  return {
    ok: true,
    context: {
      type: "space",
      store,
      core,
      space,
      principalId,
      ownerId,
      apiKeyId,
      treeAccess,
      admin,
      authenticatedAs,
    },
  };
}
