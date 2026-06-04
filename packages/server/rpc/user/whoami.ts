/**
 * whoami handler for the user RPC — the identity behind the session token.
 */
import type { WhoamiParams, WhoamiResult } from "@memory.build/protocol/user";
import { whoamiParams } from "@memory.build/protocol/user";
import { AppError } from "../errors";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

async function whoami(
  _params: WhoamiParams,
  context: HandlerContext,
): Promise<WhoamiResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  const user = await ctx.auth.getUser(ctx.userId);
  if (!user) {
    // The session validated but the user row is gone — treat as unauthenticated.
    throw new AppError("UNAUTHORIZED", "User not found");
  }
  return { id: user.id, email: user.email, name: user.name };
}

export const whoamiMethods = buildRegistry()
  .register("whoami", whoamiParams, whoami)
  .build();
