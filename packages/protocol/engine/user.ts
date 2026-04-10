/**
 * User method schemas — params and results for user.* RPC methods.
 */
import { z } from "zod";
import { uuidv7Schema } from "../fields.ts";

// =============================================================================
// Params Schemas
// =============================================================================

/**
 * user.create params.
 */
export const userCreateParams = z.object({
  id: uuidv7Schema.optional().nullable(),
  name: z.string().min(1, "name is required"),
  identityId: uuidv7Schema.optional().nullable(),
  canLogin: z.boolean().optional(),
  superuser: z.boolean().optional(),
  createrole: z.boolean().optional(),
});

export type UserCreateParams = z.infer<typeof userCreateParams>;

/**
 * user.get params.
 */
export const userGetParams = z.object({
  id: uuidv7Schema,
});

export type UserGetParams = z.infer<typeof userGetParams>;

/**
 * user.getByName params.
 */
export const userGetByNameParams = z.object({
  name: z.string().min(1),
});

export type UserGetByNameParams = z.infer<typeof userGetByNameParams>;

/**
 * user.list params.
 */
export const userListParams = z.object({
  canLogin: z.boolean().optional(),
});

export type UserListParams = z.infer<typeof userListParams>;

/**
 * user.rename params.
 */
export const userRenameParams = z.object({
  id: uuidv7Schema,
  name: z.string().min(1, "name is required"),
});

export type UserRenameParams = z.infer<typeof userRenameParams>;

/**
 * user.delete params.
 */
export const userDeleteParams = z.object({
  id: uuidv7Schema,
});

export type UserDeleteParams = z.infer<typeof userDeleteParams>;

// =============================================================================
// Result Schemas
// =============================================================================

/**
 * Single user response — returned by create, get, getByName.
 */
export const userResponse = z.object({
  id: z.string(),
  name: z.string(),
  identityId: z.string().nullable(),
  canLogin: z.boolean(),
  superuser: z.boolean(),
  createrole: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

export type UserResponse = z.infer<typeof userResponse>;

/**
 * user.list result.
 */
export const userListResult = z.object({
  users: z.array(userResponse),
});

export type UserListResult = z.infer<typeof userListResult>;

/**
 * user.rename result.
 */
export const userRenameResult = z.object({
  renamed: z.boolean(),
});

export type UserRenameResult = z.infer<typeof userRenameResult>;

/**
 * user.delete result.
 */
export const userDeleteResult = z.object({
  deleted: z.boolean(),
});

export type UserDeleteResult = z.infer<typeof userDeleteResult>;
