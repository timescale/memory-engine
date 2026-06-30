/**
 * User RPC method registry — served at `/api/v1/user/rpc` (account-scoped):
 * identity (`whoami`), space discovery (`space.list`), and the user's
 * account-management surface (agent lifecycle, api keys, space lifecycle).
 */
import type { MethodRegistry } from "../types";
import { agentMethods } from "./agent";
import { apiKeyMethods } from "./api-key";
import { inviteeMethods } from "./invitation";
import { spaceMethods } from "./space";
import { assertUserRpcContext, requireUserCaller } from "./types";
import { whoamiMethods } from "./whoami";

export {
  assertUserRpcContext,
  isUserRpcContext,
  type UserRpcContext,
} from "./types";

/**
 * Methods any authenticated principal may call — including an agent acting with
 * `ME_API_KEY`. These are account-scoped *reads* that manage nothing.
 *
 * This is an ALLOW-LIST: {@link gateAgentAccess} denies a non-user (agent)
 * caller on every method NOT listed here. So the safe default for a newly-added
 * user-RPC method is "user-only" — forgetting to list it denies agents rather
 * than exposing the account. Authentication (authenticateUser) admits any
 * principal; this is the per-method authorization layered on top.
 */
const AGENT_ALLOWED: ReadonlySet<string> = new Set(["whoami", "space.list"]);

/**
 * Gate a user-RPC registry so every method outside {@link AGENT_ALLOWED} rejects
 * a non-user (agent) caller. Account management (agents, api keys, space
 * lifecycle) is user-only: an agent is owned by a user, owns no
 * agents/spaces/keys, and is never an admin.
 *
 * The denial is an `authorize` hook (run by the dispatcher BEFORE param
 * validation), not a handler wrapper — so an agent always gets the same
 * `FORBIDDEN` regardless of whether its params happen to be valid, and its
 * input is never parsed for a call it may not make.
 */
function gateAgentAccess(registry: MethodRegistry): MethodRegistry {
  const gated: MethodRegistry = new Map();
  for (const [method, registered] of registry) {
    if (AGENT_ALLOWED.has(method)) {
      gated.set(method, registered);
      continue;
    }
    gated.set(method, {
      ...registered,
      authorize: (ctx) => {
        assertUserRpcContext(ctx);
        requireUserCaller(ctx);
      },
    });
  }
  return gated;
}

/**
 * The user-endpoint registry: identity + space discovery (open to any
 * principal) + agent/api-key/space management (user-only, gated above).
 */
export const userMethods: MethodRegistry = gateAgentAccess(
  new Map([
    ...whoamiMethods,
    ...agentMethods,
    ...apiKeyMethods,
    ...spaceMethods,
    ...inviteeMethods,
  ]),
);
