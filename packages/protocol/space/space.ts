/**
 * Active-space method schemas (space.* on the memory RPC endpoint).
 *
 * These methods are scoped by the X-Me-Space header, unlike user-endpoint
 * space.* methods that operate on the caller's global account context.
 */
import { z } from "zod";

export const spaceMemberKindSchema = z.enum(["u", "a", "s"]);
export type SpaceMemberKind = z.infer<typeof spaceMemberKindSchema>;

export const spaceMemberResponse = z.object({
  id: z.string(),
  kind: spaceMemberKindSchema,
  name: z.string(),
});
export type SpaceMemberResponse = z.infer<typeof spaceMemberResponse>;

// space.listMembers — list direct user/agent/service-account members of the
// active space. Groups are principals, but not members, so they are excluded.
export const spaceListMembersParams = z.object({
  kind: spaceMemberKindSchema.optional().nullable(),
});
export type SpaceListMembersParams = z.infer<typeof spaceListMembersParams>;

export const spaceListMembersResult = z.object({
  members: z.array(spaceMemberResponse),
});
export type SpaceListMembersResult = z.infer<typeof spaceListMembersResult>;
