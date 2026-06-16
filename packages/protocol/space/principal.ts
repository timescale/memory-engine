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
import { nameSchema, uuidv7Schema } from "../fields.ts";

/** Principal kind: user / group / agent. */
export const principalKindSchema = z.enum(["u", "g", "a"]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

/**
 * A principal that is a member of a space — i.e. has a direct membership row
 * (group membership alone does not make you a space member). `admin` is the
 * effective space-admin status (a direct admin row OR a direct member who
 * belongs to an admin group, never an agent).
 */
export const spacePrincipalResponse = z.object({
  id: z.string(),
  kind: principalKindSchema,
  name: z.string(),
  ownerId: z.string().nullable(),
  admin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type SpacePrincipalResponse = z.infer<typeof spacePrincipalResponse>;

/** A principal reference: the minimal shape returned by resolve / lookup. */
export const principalRef = z.object({
  id: z.string(),
  kind: principalKindSchema,
  name: z.string(),
});
export type PrincipalRef = z.infer<typeof principalRef>;

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

// principal.resolve — resolve principals in this space by exact name
// (case-insensitive), optionally constrained to a kind. Available to any space
// member: a targeted name->id lookup, not roster enumeration (that is
// principal.list). Returns all matches so the caller can detect ambiguity.
export const principalResolveParams = z.object({
  name: z.string().min(1),
  kind: principalKindSchema.optional().nullable(),
});
export type PrincipalResolveParams = z.infer<typeof principalResolveParams>;

export const principalResolveResult = z.object({
  principals: z.array(principalRef),
});
export type PrincipalResolveResult = z.infer<typeof principalResolveResult>;

// principal.lookup — reverse lookup: resolve a batch of principal ids to their
// names/kinds (for display, e.g. grant listings). Available to any space member;
// only ids that are in the space come back (you cannot enumerate by guessing).
export const principalLookupParams = z.object({
  ids: z.array(uuidv7Schema),
});
export type PrincipalLookupParams = z.infer<typeof principalLookupParams>;

export const principalLookupResult = z.object({
  principals: z.array(principalRef),
});
export type PrincipalLookupResult = z.infer<typeof principalLookupResult>;

// shared by agent.* / group.* mutation results
export { nameSchema };
