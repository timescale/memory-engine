/**
 * Space membership method schemas (principal.*).
 *
 * The space management API, served on POST /api/v1/memory/rpc, follows the core
 * model: principals (users/agents/groups), space membership, group membership,
 * 3-level tree-access grants, and agent api keys. All methods are scoped to the
 * space selected by the X-Me-Space header and require space-owner authority.
 *
 * "Principal" is the union (user | agent | group); the space roster holds
 * principals. "Member" is reserved for the user/agent sense (group members,
 * api-key holders).
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
export const spacePrincipalResponse = z.object({
  id: z.string(),
  kind: principalKindSchema,
  name: z.string(),
  ownerId: z.string().nullable(),
  direct: z.boolean(),
  admin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type SpacePrincipalResponse = z.infer<typeof spacePrincipalResponse>;

/** A resolved principal (used by principal.resolveByEmail). */
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

// principal.list
export const principalListParams = z.object({
  kind: principalKindSchema.optional().nullable(),
});
export type PrincipalListParams = z.infer<typeof principalListParams>;

export const principalListResult = z.object({
  principals: z.array(spacePrincipalResponse),
});
export type PrincipalListResult = z.infer<typeof principalListResult>;

// principal.add
export const principalAddParams = z.object({
  principalId: uuidv7Schema,
  admin: z.boolean().optional(),
});
export type PrincipalAddParams = z.infer<typeof principalAddParams>;

export const principalAddResult = z.object({ added: z.boolean() });
export type PrincipalAddResult = z.infer<typeof principalAddResult>;

// principal.remove
export const principalRemoveParams = z.object({ principalId: uuidv7Schema });
export type PrincipalRemoveParams = z.infer<typeof principalRemoveParams>;

export const principalRemoveResult = z.object({ removed: z.boolean() });
export type PrincipalRemoveResult = z.infer<typeof principalRemoveResult>;

// principal.resolveByEmail — find a global user by email (to add to the space)
export const principalResolveByEmailParams = z.object({ email: emailSchema });
export type PrincipalResolveByEmailParams = z.infer<
  typeof principalResolveByEmailParams
>;

export const principalResolveByEmailResult = z.object({
  principal: principalResponse.nullable(),
});
export type PrincipalResolveByEmailResult = z.infer<
  typeof principalResolveByEmailResult
>;

// shared by agent.* / group.* mutation results
export { nameSchema };
