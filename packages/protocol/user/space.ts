/**
 * Space method schemas (space.*) for the user RPC.
 *
 * Lets a logged-in user discover the spaces they belong to — used by the CLI to
 * select the X-Me-Space the rest of the commands are scoped to.
 */
import { z } from "zod";

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
