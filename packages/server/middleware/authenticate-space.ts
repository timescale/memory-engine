/**
 * Authentication for the space memory RPC (`/api/v1/memory/rpc`).
 *
 * Resolves an authenticated principal and a target space into the access set
 * (`treeAccess`) that the space SQL functions consume. Two credential modes,
 * discriminated by whether the bearer token parses as an api key:
 *
 *   - api key (agent): `me.<slug>.<lookupId>.<secret>` — validated against core.
 *   - session (human): an opaque session token — validated against auth.
 *
 * The space is always selected by the `X-Me-Space` header (uniform for both
 * modes). `core.buildTreeAccess(principalId, space.id)` is the single
 * authorization gate: a principal with no grants in the space (including an api
 * key minted for a different space) resolves to an empty set and is denied.
 */
import type { AuthStore } from "@memory.build/auth";
import { slugToSchema } from "@memory.build/database";
import {
  type CoreStore,
  parseApiKey,
  type Space,
  type TreeAccess,
} from "@memory.build/engine/core";
import { type SpaceStore, spaceStore } from "@memory.build/engine/space";
import { SPACE_HEADER } from "@memory.build/protocol/headers";
import { debug, span } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { error, forbidden, unauthorized } from "../util/response";
import { extractBearerToken } from "./authenticate";

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

  // 1. Bearer token (a session token or an api key).
  const token = extractBearerToken(request);
  if (!token) {
    debug("space auth failed: missing Authorization header");
    return {
      ok: false,
      error: unauthorized("Missing or invalid Authorization header"),
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

  // 4. Resolve the principal — the only line that differs between modes.
  const parsed = parseApiKey(token);
  let principalId: string;
  let apiKeyId: string | null;

  if (parsed) {
    // The api key embeds its own slug; assert it matches the header so a
    // misrouted key gives a clear error rather than a confusing 403 below.
    if (parsed.spaceSlug !== slug) {
      debug("space auth failed: api key slug != header", {
        slug,
        keySlug: parsed.spaceSlug,
      });
      return {
        ok: false,
        error: error(
          `API key is not valid for space ${slug}`,
          400,
          "SPACE_MISMATCH",
        ),
      };
    }
    const validated = await core.validateApiKey(parsed.lookupId, parsed.secret);
    if (!validated) {
      debug("space auth failed: invalid api key");
      return { ok: false, error: unauthorized("Invalid credentials") };
    }
    principalId = validated.memberId;
    apiKeyId = validated.apiKeyId;
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
      apiKeyId,
      treeAccess,
      admin,
    },
  };
}
