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
 * User-facing tree-path input pattern. This is the *lenient* wire form, not the
 * canonical ltree: separators may be `.` or `/`, a leading `~` is the home
 * shortcut, and labels are ltree labels (`[A-Za-z0-9_-]`). The empty string is
 * the root. Every handler that accepts this normalizes it server-side via
 * `normalizeTreePath` (see packages/database/space/path.ts), which is the
 * authoritative validator — it rejects malformed labels and a misplaced `~`
 * with a TreePathError mapped to a validation error. This regex is only a cheap
 * shape gate so obviously-bad characters (spaces, etc.) fail fast.
 *
 * Keeping this lenient (rather than the strict canonical ltree) is required so
 * the documented `~`/`share` conventions and slash separators actually work
 * over the wire on create/update/move/tree/grant — all of which normalize.
 */
const treePathInputPattern = /^[A-Za-z0-9_~./-]*$/;

/**
 * Tree path schema (lenient user-facing input; allows empty string for root).
 */
export const treePathSchema = z
  .string()
  .regex(
    treePathInputPattern,
    "must be a tree path (labels [A-Za-z0-9_-], '.' or '/' separated, optional leading '~')",
  );

/**
 * The reserved shared-tree root. This is the single source of truth for the
 * `"share"` literal across the codebase (the database boundary re-exports it).
 * It is the conventional default for memories that should be visible to the
 * whole space — `memory.create`/`batchCreate` now require an explicit `tree`,
 * so callers that previously relied on a server-side default (the file
 * importers) default to this.
 */
export const SHARE_NAMESPACE = "share";

/**
 * Memory name (leaf) — an optional, mutable, filename-like slug, unique within
 * its tree path. Must start alphanumeric, then `[A-Za-z0-9._-]` (no slashes or
 * spaces; dots are fine because a name is never an ltree label). Mirrors the
 * `memory.name` CHECK in the space schema.
 */
export const memoryNameSchema = z
  .string()
  .min(1, "name must not be empty")
  .max(128, "name must be at most 128 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "name must be a filename-like slug: start alphanumeric, then [A-Za-z0-9._-]",
  );

/**
 * A `tree/name` address (for getByPath/deleteByPath), split at the final `/`:
 * the leaf is the name, the rest is the tree. The tree part is lenient (as
 * elsewhere), but the leaf must be a valid memory name — so a trailing `/`
 * (empty leaf) or a leaf with name-illegal chars (a leading `.`/`-`/`~`) fails
 * fast as VALIDATION_ERROR rather than masquerading as NOT_FOUND.
 */
export const memoryPathSchema = treePathSchema
  .min(1, "path is required")
  .refine(
    (p) => memoryNameSchema.safeParse(p.slice(p.lastIndexOf("/") + 1)).success,
    "path must end in a valid memory name (filename-like slug; no trailing '/')",
  );

/**
 * What a create/batchCreate row does when it conflicts with the existing memory
 * on its idempotency key — a named row's `(tree, name)` slot (name takes
 * precedence), else the explicit id: `error` (default) raises CONFLICT;
 * `replace` overwrites in place but is a no-op when nothing changed; `ignore`
 * skips, leaving the existing row. Note this governs the idempotency-key
 * conflict only — a row whose explicit id collides with a *different* existing
 * row still raises a pk violation regardless of `ignore`/`replace`.
 */
export const onConflictSchema = z.enum(["error", "replace", "ignore"]);

/** What a create/batchCreate did to one row. */
export const writeStatusSchema = z.enum(["inserted", "updated", "skipped"]);

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
export const grantActionSchema = z.enum(["read", "create", "update", "delete"]);

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

/**
 * Agent/group principal names are CLI handles, not emails. User principal names
 * remain emails and are validated at the auth boundary.
 */
export const principalHandleNameSchema = z
  .string()
  .min(1, "name is required")
  .max(100, "name must be at most 100 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "name must start alphanumeric and contain only letters, numbers, '.', '_', or '-'",
  );

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
