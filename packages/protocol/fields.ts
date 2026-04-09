/**
 * Shared field validators — single source of truth.
 *
 * Both server (validation) and client (type inference) import from here.
 * This prevents drift in core validation logic.
 */
import { z } from "zod";

// =============================================================================
// Universal Fields
// =============================================================================

/**
 * UUID v7 schema using Zod 4's native uuidv7 support.
 */
export const uuidv7Schema = z.uuidv7();

/**
 * ISO 8601 timestamp string using Zod 4's native support.
 * Allows timezone offsets (e.g., "2024-01-01T00:00:00+02:00" or "2024-01-01T00:00:00Z").
 */
export const timestampSchema = z.iso.datetime({ offset: true });

// =============================================================================
// Engine Fields — Tree, Temporal, Meta, Search
// =============================================================================

/**
 * ltree path pattern (alphanumeric and underscores, dot-separated).
 */
const ltreePattern = /^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$/;

/**
 * Tree path schema (ltree format, allows empty string for root).
 */
export const treePathSchema = z
  .string()
  .regex(
    ltreePattern,
    "must be a valid ltree path (alphanumeric/underscore, dot-separated)",
  );

/**
 * Tree filter schema (ltree, lquery, or ltxtquery).
 * More permissive than treePathSchema since it allows query operators.
 */
export const treeFilterSchema = z.string().min(1);

/**
 * Temporal range schema for create/update.
 */
export const temporalSchema = z.object({
  start: timestampSchema,
  end: z.union([timestampSchema, z.null()]).optional(),
});

/**
 * Temporal filter for search.
 */
export const temporalFilterSchema = z.object({
  contains: timestampSchema.optional(),
  overlaps: z
    .object({
      start: timestampSchema,
      end: timestampSchema,
    })
    .optional(),
  within: z
    .object({
      start: timestampSchema,
      end: timestampSchema,
    })
    .optional(),
});

/**
 * Metadata schema (arbitrary JSON object).
 */
export const metaSchema = z.record(z.string(), z.unknown());

/**
 * Search weights schema.
 */
export const searchWeightsSchema = z.object({
  semantic: z.number().min(0).max(1).optional(),
  fulltext: z.number().min(0).max(1).optional(),
});

/**
 * Valid actions for tree grants.
 */
export const grantActionSchema = z.enum(["read", "write", "delete", "admin"]);

// =============================================================================
// Accounts Fields — Org, Identity, Engine
// =============================================================================

/**
 * Org role schema.
 */
export const orgRoleSchema = z.enum(["owner", "admin", "member"]);

/**
 * Engine status schema.
 */
export const engineStatusSchema = z.enum(["active", "suspended", "deleted"]);

/**
 * Slug schema (lowercase alphanumeric with hyphens, 3-50 chars).
 */
export const slugSchema = z
  .string()
  .min(3, "slug must be at least 3 characters")
  .max(50, "slug must be at most 50 characters")
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "slug must be lowercase alphanumeric with hyphens",
  );

/**
 * Email schema using Zod 4's native support.
 */
export const emailSchema = z.email();

/**
 * Name schema (1-100 chars).
 */
export const nameSchema = z
  .string()
  .min(1, "name is required")
  .max(100, "name must be at most 100 characters");

// =============================================================================
// Inferred Types
// =============================================================================

export type Temporal = z.infer<typeof temporalSchema>;
export type TemporalFilter = z.infer<typeof temporalFilterSchema>;
export type Meta = z.infer<typeof metaSchema>;
export type SearchWeights = z.infer<typeof searchWeightsSchema>;
export type GrantAction = z.infer<typeof grantActionSchema>;
export type OrgRole = z.infer<typeof orgRoleSchema>;
export type EngineStatus = z.infer<typeof engineStatusSchema>;
