/**
 * Authentication for the space memory RPC (`/api/v1/memory/rpc`).
 *
 * Resolves an authenticated principal and a target space into a member context,
 * including the access set (`treeAccess`) that the space SQL functions consume.
 * Two credential modes, discriminated by whether the bearer token parses as an
 * api key:
 *
 *   - api key (agent): `me.<lookupId>.<secret>` — validated against core.
 *   - human: an OAuth access token (Bearer, CLI/MCP) or a better-auth cookie
 *     session — both opaque, validated against the auth schema.
 *
 * The space is always selected by the `X-Me-Space` header (uniform for both
 * modes). Direct `principal_space` membership is the endpoint admission gate;
 * tree grants are data authorization and may legitimately be empty.
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
import { AS_AGENT_HEADER, SPACE_HEADER } from "@memory.build/protocol/headers";
import { debug, span } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import type { Auth, VerifyOAuthAccessToken } from "../auth/betterauth";
import { error, forbidden, unauthorized } from "../util/response";
import { resolveOwnedAgent } from "./act-as-agent";
import { extractBearerToken, passesCsrfCheck } from "./authenticate";

export { SPACE_HEADER };

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
  /** Authenticated principal kind after any act-as-agent switch. */
  principalKind: "u" | "a" | "s";
  /**
   * The authenticated principal's owner — non-null when it is an agent, null for
   * a user/session. Drives `~` home nesting (an agent's home lives under its
   * owner's home).
   */
  ownerId: string | null;
  /** Api key id when authenticated by api key; null for sessions. */
  apiKeyId: string | null;
  /** The principal's effective grants in this space. May be empty. */
  treeAccess: TreeAccess;
  /** Whether the principal is a space admin (principal_space.admin). */
  admin: boolean;
  /**
   * When a human is acting as one of their own agents (via `X-Me-As-Agent`),
   * the human's principal id; null otherwise. Observability only — never gates
   * authorization (which reads `principalId` / `ownerId` / `treeAccess` /
   * `admin`, all already switched to the agent).
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
  let principalKind: "u" | "a" | "s";
  let apiKeyId: string | null;
  // The principal's owner — set only for an agent key; drives `~` home nesting.
  let ownerId: string | null = null;

  if (parsed) {
    // Api keys are global; the space comes solely from the header. A key whose
    // principal isn't a member of this space falls through to the membership
    // gate below (403), not a parse-time rejection.
    const validated = await core.validateApiKey(parsed.lookupId, parsed.secret);
    if (!validated) {
      debug("space auth failed: invalid api key");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = validated.memberId;
    apiKeyId = validated.apiKeyId;
    ownerId = validated.ownerId;
    // validate_api_key already joined core.principal, so the kind comes back with
    // the validation — no second lookup. A group holds no key, so kind 'g' would
    // only appear if a member were torn down under a live key.
    if (validated.kind === "g") {
      debug("space auth failed: api key principal not found");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalKind = validated.kind;
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
    principalKind = "u";
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
    principalKind = "u";
    apiKeyId = null;
  }

  // 4b. Act-as-agent switch. A human credential (session / OAuth / user PAT,
  // signalled by a null owner) may send `X-Me-As-Agent` to run as one of their
  // own agents. An agent key already IS an agent (non-null owner) → the header
  // is ignored. Done BEFORE the membership gate (step 5) and the admin check
  // (step 6) so `treeAccess`, `~`-home nesting, and `admin` all reflect the agent.
  let authenticatedAs: string | null = null;
  const asAgent = request.headers.get(AS_AGENT_HEADER);
  if (asAgent && principalKind === "u") {
    const agents = await core.listAgents(principalId);
    const resolved = resolveOwnedAgent(agents, asAgent);
    if (resolved.kind !== "found") {
      debug("space auth failed: X-Me-As-Agent not an owned agent", {
        principalId,
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
    // Overwrite the resolved principal to the agent, reusing the existing agent
    // semantics so parity with the agent-key path is automatic. The human owns
    // the agent, so `ownerId = human` drives `~` home nesting the same way.
    authenticatedAs = principalId;
    ownerId = principalId;
    principalId = agent.id;
    principalKind = "a";
  }

  // 5. Endpoint admission is direct space membership (principal_space), not
  // tree access. A member may legitimately have no tree grants; data-plane
  // methods still enforce that later through the space SQL functions.
  if (!(await core.isPrincipalInSpace(principalId, space.id))) {
    debug("space auth failed: principal is not a space member", {
      slug,
      principalId,
    });
    return { ok: false, error: forbidden("No access to this space") };
  }

  // 6. Bind the data-plane store to this space's schema, resolve management
  // authority, and eagerly compute the effective tree grants consumed by data
  // handlers. `buildTreeAccess(agentId, spaceId)` applies the `agent_tree_access`
  // clamp internally, so act-as remains byte-identical to the agent-key path.
  const store = spaceStore(db, slugToSchema(space.slug));
  const admin = await core.isSpaceAdmin(principalId, space.id);
  const treeAccess = await core.buildTreeAccess(principalId, space.id);

  debug("space auth succeeded", {
    slug,
    principalId,
    byApiKey: apiKeyId !== null,
  });
  return {
    ok: true,
    context: {
      type: "space",
      store,
      core,
      space,
      principalId,
      principalKind,
      ownerId,
      apiKeyId,
      treeAccess,
      admin,
      authenticatedAs,
    },
  };
}
