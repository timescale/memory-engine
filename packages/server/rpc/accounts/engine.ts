/**
 * Accounts RPC engine methods.
 *
 * Implements:
 * - engine.create: Create a new engine for an organization
 * - engine.list: List engines for an organization
 * - engine.get: Get engine by ID
 * - engine.update: Update engine name/status
 * - engine.delete: Delete an engine (mark deleted + drop schema)
 * - engine.setupAccess: Bootstrap engine access for a session-authenticated identity
 */
import type { Engine } from "@memory.build/accounts";
import {
  createEngineDB,
  type EngineConfig,
  provisionEngine,
} from "@memory.build/engine";
import type {
  EngineCreateParams,
  EngineDeleteParams,
  EngineGetParams,
  EngineListParams,
  EngineResponse,
  EngineSetupAccessParams,
  EngineSetupAccessResult,
  EngineUpdateParams,
} from "@memory.build/protocol/accounts/engine";
import {
  engineCreateParams,
  engineDeleteParams,
  engineGetParams,
  engineListParams,
  engineSetupAccessParams,
  engineUpdateParams,
} from "@memory.build/protocol/accounts/engine";
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
    await provisionEngine(
      engineSql,
      engine.slug,
      engineConfig,
      appVersion,
      engine.shardId,
    );
  } catch (err) {
    // Attempt to clean up partially-created schema
    const schema = `me_${engine.slug}`;
    try {
      await engineSql.begin(async (tx) => {
        await tx.unsafe(`set local pgdog.shard to ${engine.shardId}`);
        await tx.unsafe(`drop schema if exists ${schema} cascade`);
      });
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
      name: slugifyUserName(identity.name || identity.email),
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

/**
 * Derive a shell-friendly engine user name from a display name or email.
 * Lowercases, replaces whitespace runs with hyphens, strips non-alphanumeric
 * characters (except hyphens), and trims leading/trailing hyphens.
 */
function slugifyUserName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * engine.delete - Delete an engine permanently.
 * Marks the engine as deleted in accounts DB, then drops the schema.
 * Requires owner role on the org.
 */
async function engineDelete(
  params: EngineDeleteParams,
  context: HandlerContext,
): Promise<{ deleted: boolean }> {
  assertAccountsRpcContext(context);
  const { db, identity, engineSql } = context as AccountsRpcContext;

  const engine = await db.getEngine(params.id);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  // Only org owners can delete engines
  const member = await db.getMember(engine.orgId, identity.id);
  if (!member || member.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only owners can delete engines");
  }

  // Already deleted — idempotent
  if (engine.status === "deleted") {
    return { deleted: true };
  }

  // Mark as deleted first (blocks new API key auth immediately)
  await db.updateEngine(engine.id, { status: "deleted" });

  // Drop the engine schema with retries (in-flight operations may hold locks)
  const schema = `me_${engine.slug}`;
  await dropSchemaWithRetry(engineSql, schema, {
    retries: 3,
    delayMs: 2000,
    shardId: engine.shardId,
  });

  return { deleted: true };
}

/**
 * Drop an engine schema with retry logic.
 * Sets a lock_timeout to avoid blocking indefinitely if the embedding worker
 * or in-flight requests hold locks, then retries on timeout.
 * Sets pgdog.shard for correct shard routing.
 */
async function dropSchemaWithRetry(
  sql: import("bun").SQL,
  schema: string,
  opts: { retries: number; delayMs: number; shardId: number },
): Promise<void> {
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local pgdog.shard to ${opts.shardId}`);
        await tx.unsafe(`set local lock_timeout = '5s'`);
        await tx.unsafe(`drop schema if exists ${schema} cascade`);
      });
      return;
    } catch (err) {
      const isLockTimeout =
        err instanceof Error && err.message?.includes("lock timeout");
      if (!isLockTimeout || attempt === opts.retries) {
        throw new AppError(
          "INTERNAL_ERROR",
          `Failed to drop engine schema ${schema}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
  }
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
  .register("engine.delete", engineDeleteParams, engineDelete)
  .register("engine.setupAccess", engineSetupAccessParams, engineSetupAccess)
  .build();
