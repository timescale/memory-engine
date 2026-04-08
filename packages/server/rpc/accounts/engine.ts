/**
 * Accounts RPC engine methods.
 *
 * Implements:
 * - engine.create: Create a new engine for an organization
 * - engine.list: List engines for an organization
 * - engine.get: Get engine by ID
 * - engine.update: Update engine name/status
 */
import type { Engine } from "@memory-engine/accounts";
import { provisionEngine, type EngineConfig } from "@memory-engine/engine";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import {
  type EngineCreateParams,
  type EngineGetParams,
  type EngineListParams,
  type EngineUpdateParams,
  engineCreateSchema,
  engineGetSchema,
  engineListSchema,
  engineUpdateSchema,
} from "./schemas";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";
import { embeddingConstants } from "../../config";

// =============================================================================
// Response Types
// =============================================================================

/**
 * Engine response (serializable).
 */
interface EngineResponse {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  shardId: number;
  status: string;
  language: string;
  createdAt: string;
  updatedAt: string | null;
}

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
  const { db, identityId, engineSql, appVersion } =
    context as AccountsRpcContext;

  // Check if caller has admin or owner role
  const member = await db.getMember(params.orgId, identityId);
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
  const { db, identityId } = context as AccountsRpcContext;

  // Check if caller is a member of the org
  const member = await db.getMember(params.orgId, identityId);
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
  const { db, identityId } = context as AccountsRpcContext;

  const engine = await db.getEngine(params.id);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  // Check if caller is a member of the org
  const member = await db.getMember(engine.orgId, identityId);
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
  const { db, identityId } = context as AccountsRpcContext;

  const engine = await db.getEngine(params.id);
  if (!engine) {
    throw new AppError("NOT_FOUND", `Engine not found: ${params.id}`);
  }

  // Check if caller has admin or owner role
  const member = await db.getMember(engine.orgId, identityId);
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

// =============================================================================
// Registry
// =============================================================================

/**
 * Build the engine methods registry.
 */
export const engineMethods = buildRegistry()
  .register("engine.create", engineCreateSchema, engineCreate)
  .register("engine.list", engineListSchema, engineList)
  .register("engine.get", engineGetSchema, engineGet)
  .register("engine.update", engineUpdateSchema, engineUpdate)
  .build();
