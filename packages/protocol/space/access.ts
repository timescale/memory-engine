/**
 * Effective access introspection schemas (access.*).
 *
 * Raw grant rows live under grant.*. Effective access is the access set a member
 * actually executes with after direct grants, group grants, and agent owner
 * clamps are resolved.
 */
import { z } from "zod";
import { uuidv7Schema } from "../fields.ts";
import { accessLevelSchema } from "./grant.ts";

const executablePrincipalKindSchema = z.enum(["u", "a", "s"]);

export const effectiveAccessEntry = z.object({
  treePath: z.string(),
  access: accessLevelSchema,
  accessName: z.enum(["read", "write", "owner"]),
});
export type EffectiveAccessEntry = z.infer<typeof effectiveAccessEntry>;

export const effectiveAccessPrincipal = z.object({
  id: z.string(),
  kind: executablePrincipalKindSchema,
  name: z.string(),
  ownerId: z.string().nullable(),
  admin: z.boolean(),
});
export type EffectiveAccessPrincipal = z.infer<typeof effectiveAccessPrincipal>;

export const effectiveAccessAuthenticatedAs = z.object({
  id: z.string(),
  kind: executablePrincipalKindSchema,
  name: z.string(),
});
export type EffectiveAccessAuthenticatedAs = z.infer<
  typeof effectiveAccessAuthenticatedAs
>;

export const accessEffectiveParams = z.object({
  /** Principal to inspect. Omit/null for the current acting principal. */
  principalId: uuidv7Schema.optional().nullable(),
});
export type AccessEffectiveParams = z.infer<typeof accessEffectiveParams>;

export const accessEffectiveResult = z.object({
  space: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  principal: effectiveAccessPrincipal,
  authenticatedAs: effectiveAccessAuthenticatedAs.nullable(),
  access: z.array(effectiveAccessEntry),
});
export type AccessEffectiveResult = z.infer<typeof accessEffectiveResult>;
