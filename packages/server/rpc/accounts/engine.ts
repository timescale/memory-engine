/**
 * Accounts RPC engine methods.
 *
 * Implements:
 * - engine.create: Create a new engine for an organization
 * - engine.list: List engines for an organization
 * - engine.get: Get engine by ID
 * - engine.update: Update engine name/status
 * - engine.setupAccess: Bootstrap engine access for a session-authenticated identity
 */
import type { Engine } from "@memory-engine/accounts";
import {
  createEngineDB,
  type EngineConfig,
  provisionEngine,
} from "@memory-engine/engine";
import type {
  EngineCreateParams,
  EngineGetParams,
  EngineListParams,
  EngineResponse,
  EngineSetupAccessParams,
  EngineSetupAccessResult,
  EngineUpdateParams,
} from "@memory-engine/protocol/accounts/engine";
import {
  engineCreateParams,
  engineGetParams,
  engineListParams,
  engineSetupAccessParams,
  engineUpdateParams,
} from "@memory-engine/protocol/accounts/engine";
import { embeddingConstants } from "../../config";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

/**
 * Convert an Engine to a serializable response.
 */
function toEngineResponse(engine: Engine): EngineResponse {
  return {
    id: engine.id,
    orgId: engine.orgId,
    slug: engine.slug,
    name: engine.name,
    shardId: engine.shardId,
    status: engine.status,
    language: engine.language,
    createdAt: engine.createdAt.toISOString(),
    updatedAt: engine.updatedAt?.toISOString() ?? null,
  };
}

// =============================================================================
// Method Handlers
// =============================================================================

/**
 * engine.create - Create a new engine for an organization.
 * Requires owner or admin role.
 */
async function engineCreate(
  params: EngineCreateParams,
  context: HandlerContext,
): Promise<EngineResponse> {
  assertAccountsRpcContext(context);
  const { db, identity, engineSql, appVersion } = context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const member = await db.getMember(params.orgId, identity.id);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can create engines",
    );
  }

  // Create the engine record in accounts DB
  const engine = await db.createEngine({
    orgId: params.orgId,
    name: params.name,
    language: params.language ?? "english",
  });

  // Provision the engine schema in the engine DB
  const engineConfig: EngineConfig = {
    embedding_dimensions: embeddingConstants.dimensions,
    bm25_text_config: engine.language,
  };

  try {
    await provisionEngine(engineSql, engine.slug, engineConfig, appVersion);
  } catch (err) {
    // Attempt to clean up partially-created schema
    const schema = `me_${engine.slug}`;
    try {
      await engineSql.unsafe(`drop schema if exists ${schema} cascade`);
    } catch {
      // Log but don't mask original error
    }
    // Mark engine as deleted in accounts DB
    await db.updateEngine(engine.id, { status: "deleted" });
    throw new AppError(
      "INTERNAL_ERROR",
      `Failed to provision engine schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return toEngineResponse(engine);
}

/**
 * engine.list - List engines for an organization.
 * Requires membership in the org.
 */
async function engineList(
  params: EngineListParams,
  context: HandlerContext,
): Promise<{ engines: EngineResponse[] }> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const member = await db.getMember(params.orgId, identity.id);
  if (!member) {
    throw new AppError("FORBIDDEN", "Not a member of this organization");
  }

  const engines = await db.listEnginesByOrg(params.orgId);
  return { engines: engines.map(toEngineResponse) };
}

/**
 * engine.get - Get engine by ID.
 * Requires membership in the org that owns the engine.
 */
async function engineGet(
  params: EngineGetParams,
  context: HandlerContext,
): Promise<EngineResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  const engine = await db.getEngine(params.id);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  // Check if caller is a member of the org
  const member = await db.getMember(engine.orgId, identity.id);
  if (!member) {
    throw new AppError(
      "FORBIDDEN",
      "Not a member of the organization that owns this engine",
    );
  }

  return toEngineResponse(engine);
}

/**
 * engine.update - Update engine name/status.
 * Requires owner or admin role.
 */
async function engineUpdate(
  params: EngineUpdateParams,
  context: HandlerContext,
): Promise<EngineResponse> {
  assertAccountsRpcContext(context);
  const { db, identity } = context as AccountsRpcContext;

  const engine = await db.getEngine(params.id);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  // Check if caller has admin or owner role
  const member = await db.getMember(engine.orgId, identity.id);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw new AppError(
      "FORBIDDEN",
      "Only owners and admins can update engines",
    );
  }

  const updated = await db.updateEngine(params.id, {
    name: params.name,
    status: params.status,
  });

  if (!updated) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  const updatedEngine = await db.getEngine(params.id);
  if (!updatedEngine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  return toEngineResponse(updatedEngine);
}

/**
 * engine.setupAccess - Bootstrap engine access for a session-authenticated identity.
 *
 * Find-or-creates an engine user for the caller's identity, then creates an API key.
 * Any org member can call this. Privilege level maps from org role:
 *   - owner/admin → superuser + createrole
 *   - member → vanilla user
 */
async function engineSetupAccess(
  params: EngineSetupAccessParams,
  context: HandlerContext,
): Promise<EngineSetupAccessResult> {
  assertAccountsRpcContext(context);
  const { db, identity, engineSql } = context as AccountsRpcContext;

  // Look up the engine
  const engine = await db.getEngine(params.engineId);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.engineId}`);
  }
  if (engine.status !== "active") {
    throw new AppError(
      "VALIDATION_ERROR",
      `Engine is not active: ${engine.status}`,
    );
  }

  // Look up the org
  const org = await db.getOrg(engine.orgId);
  if (!org) {
    throw new AppError("NOT_FOUND", `Organization not found: ${engine.orgId}`);
  }

  // Check caller's membership
  const member = await db.getMember(engine.orgId, identity.id);
  if (!member) {
    throw new AppError(
      "FORBIDDEN",
      "Not a member of the organization that owns this engine",
    );
  }

  // Create an EngineDB for this engine's schema
  const schema = `me_${engine.slug}`;
  const engineDb = createEngineDB(engineSql, schema);

  // Find or create a user for this identity
  let user = await engineDb.getUserByIdentity(identity.id);
  if (!user) {
    const isSuperuser = member.role === "owner" || member.role === "admin";
    user = await engineDb.createUser({
      name: identity.name || identity.email,
      identityId: identity.id,
      canLogin: true,
      superuser: isSuperuser,
      createrole: isSuperuser,
    });
  }

  // Create an API key for the user
  const apiKeyName =
    params.apiKeyName ?? `cli-${new Date().toISOString().slice(0, 10)}`;
  const { rawKey } = await engineDb.createApiKey({
    userId: user.id,
    name: apiKeyName,
  });

  return {
    rawKey,
    engineSlug: engine.slug,
    userId: user.id,
    engineName: engine.name,
    orgName: org.name,
  };
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the engine methods registry.
 */
export const engineMethods = buildRegistry()
  .register("engine.create", engineCreateParams, engineCreate)
  .register("engine.list", engineListParams, engineList)
  .register("engine.get", engineGetParams, engineGet)
  .register("engine.update", engineUpdateParams, engineUpdate)
  .register("engine.setupAccess", engineSetupAccessParams, engineSetupAccess)
  .build();
