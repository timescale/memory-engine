/**
 * User RPC method registry — served at `/api/v1/user/rpc` (account-scoped):
 * identity (`whoami`), space discovery (`space.list`), and the user's
 * account-management surface (api keys, service accounts, space lifecycle).
 */
import type { MethodRegistry } from "../types";
import { apiKeyMethods } from "./api-key";
import { inviteeMethods } from "./invitation";
import { serviceAccountMethods } from "./service-account";
import { spaceMethods } from "./space";
import {
  assertUserRpcContext,
  requireUnrestrictedApiKey,
  requireUserCaller,
} from "./types";
import { whoamiMethods } from "./whoami";

export {
  assertUserRpcContext,
  isUserRpcContext,
  type UserRpcContext,
} from "./types";

/**
 * Methods any authenticated principal may call. These are account-scoped reads
 * that manage nothing.
 *
 * This is an ALLOW-LIST: {@link gateNonUserAccess} denies a service-account
 * caller on every method NOT listed here. So the safe default for a newly-added
 * user-RPC method is "user-only" — forgetting to list it denies service accounts
 * rather than exposing the account. Authentication (authenticateUser) admits any
 * principal; this is the per-method authorization layered on top.
 */
const NON_USER_ALLOWED: ReadonlySet<string> = new Set(["whoami", "space.list"]);

/**
 * Gate a user-RPC registry so every method outside {@link NON_USER_ALLOWED}
 * rejects a service-account caller. Account management is user-only.
 *
 * The denial is an `authorize` hook (run by the dispatcher BEFORE param
 * validation), not a handler wrapper — so a service account always gets the same
 * `FORBIDDEN` regardless of whether its params happen to be valid, and its
 * input is never parsed for a call it may not make.
 */
function gateNonUserAccess(registry: MethodRegistry): MethodRegistry {
  const gated: MethodRegistry = new Map();
  for (const [method, registered] of registry) {
    if (NON_USER_ALLOWED.has(method)) {
      gated.set(method, registered);
      continue;
    }
    gated.set(method, {
      ...registered,
      authorize: (ctx) => {
        assertUserRpcContext(ctx);
        requireUnrestrictedApiKey(ctx);
        requireUserCaller(ctx);
      },
    });
  }
  return gated;
}

/**
 * The user-endpoint registry: identity + space discovery (open to any
 * principal) + account management (user-only, gated above).
 */
export const userMethods: MethodRegistry = gateNonUserAccess(
  new Map([
    ...whoamiMethods,
    ...serviceAccountMethods,
    ...apiKeyMethods,
    ...spaceMethods,
    ...inviteeMethods,
  ]),
);
