/**
 * Space membership method schemas (member.*).
 *
 * The space management API, served on POST /api/v1/memory/rpc, follows the core
 * model: principals (users/agents/groups), space membership, group membership,
 * 3-level tree-access grants, and agent api keys. All methods are scoped to the
 * space selected by the X-Me-Space header and require space-owner authority.
 */
import { z } from "zod";
import { emailSchema, nameSchema, uuidv7Schema } from "../fields.ts";

/** Principal kind: user / group / agent. */
export const principalKindSchema = z.enum(["u", "g", "a"]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

/**
 * A principal that belongs to a space — directly or via a group.
 * `direct` is true for a direct membership; `admin` is the direct-membership
 * admin flag (false for group-only members).
 */
export const spaceMemberResponse = z.object({
  id: z.string(),
  kind: principalKindSchema,
  name: z.string(),
  ownerId: z.string().nullable(),
  direct: z.boolean(),
  admin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type SpaceMemberResponse = z.infer<typeof spaceMemberResponse>;

/** A resolved principal (used by member.resolveByEmail). */
export const principalResponse = z.object({
  id: z.string(),
  kind: principalKindSchema,
  name: z.string(),
  ownerId: z.string().nullable(),
  spaceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type PrincipalResponse = z.infer<typeof principalResponse>;

// member.list
export const memberListParams = z.object({
  kind: principalKindSchema.optional().nullable(),
});
export type MemberListParams = z.infer<typeof memberListParams>;

export const memberListResult = z.object({
  members: z.array(spaceMemberResponse),
});
export type MemberListResult = z.infer<typeof memberListResult>;

// member.add
export const memberAddParams = z.object({
  principalId: uuidv7Schema,
  admin: z.boolean().optional(),
});
export type MemberAddParams = z.infer<typeof memberAddParams>;

export const memberAddResult = z.object({ added: z.boolean() });
export type MemberAddResult = z.infer<typeof memberAddResult>;

// member.remove
export const memberRemoveParams = z.object({ principalId: uuidv7Schema });
export type MemberRemoveParams = z.infer<typeof memberRemoveParams>;

export const memberRemoveResult = z.object({ removed: z.boolean() });
export type MemberRemoveResult = z.infer<typeof memberRemoveResult>;

// member.resolveByEmail — find a global user by email (to add them to the space)
export const memberResolveByEmailParams = z.object({ email: emailSchema });
export type MemberResolveByEmailParams = z.infer<
  typeof memberResolveByEmailParams
>;

export const memberResolveByEmailResult = z.object({
  principal: principalResponse.nullable(),
});
export type MemberResolveByEmailResult = z.infer<
  typeof memberResolveByEmailResult
>;

// shared by agent.* / group.* mutation results
export { nameSchema };
