/**
 * Authentication for the space memory RPC (`/api/v1/memory/rpc`).
 *
 * Resolves an authenticated principal and a target space into the access set
 * (`treeAccess`) that the space SQL functions consume. Two credential modes,
 * discriminated by whether the bearer token parses as an api key:
 *
 *   - api key (agent): `me.<lookupId>.<secret>` — validated against core.
 *   - session (human): an opaque session token — validated against auth.
 *
 * The space is always selected by the `X-Me-Space` header (uniform for both
 * modes). `core.buildTreeAccess(principalId, space.id)` is the single
 * authorization gate: a principal with no grants in the space resolves to an
 * empty set and is denied. Api keys are global, so a key whose principal isn't a
 * member of the requested space is denied here rather than at parse time.
 */
import type { AuthStore } from "@memory.build/auth";
import { slugToSchema } from "@memory.build/database";
import {
  type CoreStore,
  isLegacyApiKey,
  parseApiKey,
  type Space,
  type TreeAccess,
} from "@memory.build/engine/core";
import { type SpaceStore, spaceStore } from "@memory.build/engine/space";
import { SPACE_HEADER } from "@memory.build/protocol/headers";
import { debug, span } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { error, forbidden, unauthorized } from "../util/response";
import { extractSessionCredential, passesCsrfCheck } from "./authenticate";

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
}

export type SpaceAuthResult =
  | { ok: true; context: SpaceAuthContext }
  | { ok: false; error: Response };

export interface SpaceAuthDeps {
  /** Core control-plane store (on the new-model pool). */
  core: CoreStore;
  /** Auth store (auth schema) for session validation. */
  auth: AuthStore;
  /** New-model pool — used to bind the per-space data-plane store. */
  db: Sql;
  /** Origins allowed for cookie-authenticated (browser) requests — CSRF gate. */
  allowedOrigins: string[];
  /** Whether the public origin is HTTPS — selects the mode-aware cookie name. */
  cookieSecure: boolean;
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
  const { core, auth, db } = deps;

  // 1. Credential: an Authorization Bearer (session token or api key), or the
  //    browser session cookie (session token only).
  const credential = extractSessionCredential(request, deps.cookieSecure);
  if (!credential) {
    debug("space auth failed: missing credential");
    return {
      ok: false,
      error: unauthorized("Missing or invalid Authorization header"),
    };
  }
  // CSRF: an ambient cookie credential must come from an allowed origin. Header
  // credentials are exempt (they can't be forged cross-site).
  if (
    credential.source === "cookie" &&
    !passesCsrfCheck(request, deps.allowedOrigins)
  ) {
    debug("space auth failed: cookie request failed CSRF origin check");
    return { ok: false, error: forbidden("Cross-origin request rejected") };
  }
  const token = credential.token;

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

  // 4. Resolve the principal — the only line that differs between modes.
  const parsed = parseApiKey(token);
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
  } else if (isLegacyApiKey(token)) {
    // A pre-global 4-part key (me.<slug>.<lookup>.<secret>). These no longer
    // authenticate; tell the operator to recreate the key rather than failing
    // with a confusing generic 401.
    debug("space auth failed: legacy 4-part api key");
    return {
      ok: false,
      error: error(
        "This API key uses the old space-scoped format (me.<slug>.<id>.<secret>) and no longer works. Recreate it with `me apikey create <agent>`, then update ME_API_KEY or your MCP/plugin config.",
        401,
        "LEGACY_API_KEY",
      ),
    };
  } else {
    const session = await auth.validateSession(token);
    if (!session) {
      debug("space auth failed: invalid or expired session");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = session.userId;
    apiKeyId = null;
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
    },
  };
}
