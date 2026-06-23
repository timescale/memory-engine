/**
 * whoami handler for the user RPC — the identity behind the session token.
 */
import type { WhoamiParams, WhoamiResult } from "@memory.build/protocol/user";
import { whoamiParams } from "@memory.build/protocol/user";
import { buildRegistry } from "../registry";
import type { HandlerContext } from "../types";
import { assertUserRpcContext, type UserRpcContext } from "./types";

async function whoami(
  _params: WhoamiParams,
  context: HandlerContext,
): Promise<WhoamiResult> {
  assertUserRpcContext(context);
  const ctx = context as UserRpcContext;
  // Identity comes straight from the validated session (better-auth getSession).
  return { id: ctx.userId, email: ctx.email, name: ctx.name };
}

export const whoamiMethods = buildRegistry()
  .register("whoami", whoamiParams, whoami)
  .build();
