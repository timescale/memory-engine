/**
 * Accounts RPC me/identity methods (auth-schema backed).
 */
import type { User } from "@memory.build/auth";
import type {
  IdentityGetByEmailParams,
  IdentityGetByEmailResult,
  IdentityResponse,
  MeGetParams,
} from "@memory.build/protocol/accounts/identity";
import {
  identityGetByEmailParams,
  meGetParams,
} from "@memory.build/protocol/accounts/identity";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { type AccountsRpcContext, assertAccountsRpcContext } from "./types";

function toIdentityResponse(user: User): IdentityResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt?.toISOString() ?? null,
  };
}

/** me.get — the current authenticated user. */
async function meGet(
  _params: MeGetParams,
  context: HandlerContext,
): Promise<IdentityResponse> {
  assertAccountsRpcContext(context);
  const { auth, identity } = context as AccountsRpcContext;
  const user = await auth.getUser(identity.id);
  if (!user) {
    throw new Error("Authenticated user not found");
  }
  return toIdentityResponse(user);
}

/** identity.getByEmail — look up a user by email. */
async function identityGetByEmail(
  params: IdentityGetByEmailParams,
  context: HandlerContext,
): Promise<IdentityGetByEmailResult> {
  assertAccountsRpcContext(context);
  const { auth } = context as AccountsRpcContext;
  const user = await auth.getUserByEmail(params.email);
  return { identity: user ? toIdentityResponse(user) : null };
}

export const meMethods = buildRegistry()
  .register("me.get", meGetParams, meGet)
  .register("identity.getByEmail", identityGetByEmailParams, identityGetByEmail)
  .build();
