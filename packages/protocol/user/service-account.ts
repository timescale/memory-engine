/**
 * Service-account method schemas (serviceAccount.*) for the user RPC.
 *
 * Service accounts are space-scoped, api-key-bearing principals administered by
 * a bound users-only admin group. Their lifecycle uses the user endpoint because
 * key management is human-administered, but every lifecycle operation carries an
 * explicit space id instead of relying on X-Me-Space.
 */
import { z } from "zod";
import { principalHandleNameSchema, uuidv7Schema } from "../fields.ts";

export const serviceAccountResponse = z.object({
  id: z.string(),
  name: z.string(),
  adminId: z.string(),
  spaceId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type ServiceAccountResponse = z.infer<typeof serviceAccountResponse>;

export const serviceAccountAdminMemberInput = z.object({
  memberId: uuidv7Schema,
  admin: z.boolean().optional(),
});
export type ServiceAccountAdminMemberInput = z.infer<
  typeof serviceAccountAdminMemberInput
>;

// serviceAccount.create — create an inert service account plus its bound admin group.
export const serviceAccountCreateParams = z.object({
  spaceId: uuidv7Schema,
  name: principalHandleNameSchema,
  adminMembers: z.array(serviceAccountAdminMemberInput).optional(),
});
export type ServiceAccountCreateParams = z.infer<
  typeof serviceAccountCreateParams
>;

export const serviceAccountCreateResult = z.object({
  serviceAccount: serviceAccountResponse,
});
export type ServiceAccountCreateResult = z.infer<
  typeof serviceAccountCreateResult
>;

// serviceAccount.list — list service accounts in one space.
export const serviceAccountListParams = z.object({ spaceId: uuidv7Schema });
export type ServiceAccountListParams = z.infer<typeof serviceAccountListParams>;

export const serviceAccountListResult = z.object({
  serviceAccounts: z.array(serviceAccountResponse),
});
export type ServiceAccountListResult = z.infer<typeof serviceAccountListResult>;

// serviceAccount.rename
export const serviceAccountRenameParams = z.object({
  id: uuidv7Schema,
  name: principalHandleNameSchema,
});
export type ServiceAccountRenameParams = z.infer<
  typeof serviceAccountRenameParams
>;

export const serviceAccountRenameResult = z.object({ renamed: z.boolean() });
export type ServiceAccountRenameResult = z.infer<
  typeof serviceAccountRenameResult
>;

// serviceAccount.delete
export const serviceAccountDeleteParams = z.object({ id: uuidv7Schema });
export type ServiceAccountDeleteParams = z.infer<
  typeof serviceAccountDeleteParams
>;

export const serviceAccountDeleteResult = z.object({ deleted: z.boolean() });
export type ServiceAccountDeleteResult = z.infer<
  typeof serviceAccountDeleteResult
>;
