/**
 * Engine method schemas (accounts side) — params and results for engine.* RPC methods.
 *
 * These are the engine management methods on the accounts RPC endpoint,
 * not to be confused with the engine's own RPC methods.
 */
import { z } from "zod";
import { engineStatusSchema, nameSchema, uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * engine.create params.
 */
export const engineCreateParams = z.object({
  orgId: uuidv7Schema,
  name: nameSchema,
  language: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional()
    .default("english"),
});

export type EngineCreateParams = z.infer<typeof engineCreateParams>;

/**
 * engine.list params.
 */
export const engineListParams = z.object({
  orgId: uuidv7Schema,
});

export type EngineListParams = z.infer<typeof engineListParams>;

/**
 * engine.get params.
 */
export const engineGetParams = z.object({
  id: uuidv7Schema,
});

export type EngineGetParams = z.infer<typeof engineGetParams>;

/**
 * engine.update params.
 */
export const engineUpdateParams = z.object({
  id: uuidv7Schema,
  name: nameSchema.optional(),
  status: engineStatusSchema.optional(),
});

export type EngineUpdateParams = z.infer<typeof engineUpdateParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single engine response — returned by create, get, update.
 */
export const engineResponse = z.object({
  id: z.string(),
  orgId: z.string(),
  slug: z.string(),
  name: z.string(),
  shardId: z.number(),
  status: z.string(),
  language: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type EngineResponse = z.infer<typeof engineResponse>;

/**
 * engine.list result.
 */
export const engineListResult = z.object({
  engines: z.array(engineResponse),
});

export type EngineListResult = z.infer<typeof engineListResult>;
