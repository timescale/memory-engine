/**
 * whoami handler for the user RPC — the identity behind the credential.
 *
 * Open to any authenticated principal (it manages nothing): a human reports
 * `kind: "u"` with their email; an agent/service account acting with
 * `ME_API_KEY` reports `kind: "a"`/`kind: "s"` with a null email, so the CLI can
 * show whose context it's in.
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
  // Identity comes straight from the validated credential (no store lookup).
  return { id: ctx.userId, kind: ctx.kind, email: ctx.email, name: ctx.name };
}

export const whoamiMethods = buildRegistry()
  .register("whoami", whoamiParams, whoami)
  .build();
