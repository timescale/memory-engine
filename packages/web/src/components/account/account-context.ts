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
}

export interface AccountInfo {
  identity: AccountIdentity;
  spaces: AccountSpace[];
  space: string;
  onChooseSpace: (slug: string) => void;
  onLogout: () => void;
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
