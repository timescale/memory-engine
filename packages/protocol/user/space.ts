/**
 * Space method schemas (space.*) for the user RPC.
 *
 * Lets a logged-in user discover the spaces they belong to — used by the CLI to
 * select the X-Me-Space the rest of the commands are scoped to.
 */
import { z } from "zod";
import { nameSchema } from "../fields.ts";

export const memberSpaceResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  language: z.string(),
  /** Whether the user is a (direct) admin of the space. */
  admin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type MemberSpaceResponse = z.infer<typeof memberSpaceResponse>;

// space.list — the caller's spaces
export const spaceListParams = z.object({});
export type SpaceListParams = z.infer<typeof spaceListParams>;

export const spaceListResult = z.object({
  spaces: z.array(memberSpaceResponse),
});
export type SpaceListResult = z.infer<typeof spaceListResult>;

// space.create — create a new space; the caller becomes admin + owner@root
export const spaceCreateParams = z.object({ name: nameSchema });
export type SpaceCreateParams = z.infer<typeof spaceCreateParams>;

export const spaceCreateResult = z.object({
  id: z.string(),
  slug: z.string(),
});
export type SpaceCreateResult = z.infer<typeof spaceCreateResult>;

// space.ensureDefault — create a personal "default" space ONLY when the caller
// has zero space memberships; a no-op otherwise. The onboarding entry points
// (CLI `me login`, web AuthGate) call this when `space.list` is empty, so an
// invited user who joins via accept/redeem never gets a junk default space.
export const spaceEnsureDefaultParams = z.object({});
export type SpaceEnsureDefaultParams = z.infer<typeof spaceEnsureDefaultParams>;

export const spaceEnsureDefaultResult = z.object({
  /** True when a default space was created by this call. */
  created: z.boolean(),
  /** The created space (null when the caller already had ≥1 space). */
  space: memberSpaceResponse.nullable(),
});
export type SpaceEnsureDefaultResult = z.infer<typeof spaceEnsureDefaultResult>;

/** A space's slug (12-char routing key). */
const spaceSlugSchema = z.string().regex(/^[a-z0-9]{12}$/);

// space.rename — change a space's display name (admin only). The slug (and
// thus the me_<slug> schema, api keys, and routing) is immutable.
export const spaceRenameParams = z.object({
  slug: spaceSlugSchema,
  name: nameSchema,
});
export type SpaceRenameParams = z.infer<typeof spaceRenameParams>;

export const spaceRenameResult = z.object({ renamed: z.boolean() });
export type SpaceRenameResult = z.infer<typeof spaceRenameResult>;

// space.delete — delete a space + its data schema (admin only)
export const spaceDeleteParams = z.object({ slug: spaceSlugSchema });
export type SpaceDeleteParams = z.infer<typeof spaceDeleteParams>;

export const spaceDeleteResult = z.object({ deleted: z.boolean() });
export type SpaceDeleteResult = z.infer<typeof spaceDeleteResult>;
