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
