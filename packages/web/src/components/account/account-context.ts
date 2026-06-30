/**
 * Account context — carries the signed-in identity, available spaces, the
 * active space, and the space-switch / sign-out handlers from the hosted-mode
 * `AuthGate` down into the header's account cluster.
 *
 * Null in local mode (`me serve`), where the proxy supplies auth + the active
 * space and the browser knows neither — the header simply omits the cluster.
 */
import { createContext, useContext } from "react";

export interface AccountIdentity {
  email: string;
  name: string;
}

export interface AccountSpace {
  slug: string;
  name: string;
  /** Whether the signed-in user is an admin of this space. */
  admin: boolean;
}

/** A pending invitation addressed to the signed-in user. */
export interface AccountInvitation {
  invitationId: string;
  spaceName: string;
  spaceSlug: string;
  admin: boolean;
  shareAccess: 1 | 2 | 3 | null;
  invitedByName: string | null;
}

export interface AccountInfo {
  identity: AccountIdentity;
  spaces: AccountSpace[];
  space: string;
  onChooseSpace: (slug: string) => void;
  onLogout: () => void;
  /**
   * Pending invitations addressed to the user (hosted mode only — local `me
   * serve` omits these). The header surfaces them for accept/decline.
   */
  invitations?: AccountInvitation[];
  /** Accept an invitation by id (joins the space), then refresh. */
  onAcceptInvite?: (invitationId: string) => Promise<void>;
  /** Decline (delete) an invitation by id, then refresh. */
  onDeclineInvite?: (invitationId: string) => Promise<void>;
  /**
   * True in local mode (`me serve`), where the CLI owns the session — there is
   * no web sign-out, so the cluster hides it. The space switcher still works
   * (the proxy honors a browser-sent space).
   */
  local?: boolean;
}

const AccountContext = createContext<AccountInfo | null>(null);

export const AccountProvider = AccountContext.Provider;

export function useAccount(): AccountInfo | null {
  return useContext(AccountContext);
}
