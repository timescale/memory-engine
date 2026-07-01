/**
 * Shared identity/space formatting for `me whoami` and `me login`.
 *
 * These pure helpers keep the two commands' output in lockstep — the space
 * label (`name (slug)` + an admin marker) and the auth-method descriptor
 * (session vs api key vs agent key) render identically wherever an identity is
 * shown.
 */
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import type { ResolvedCredentials } from "./credentials.ts";

/** How the caller authenticated: an OAuth/cookie session, a user PAT, or an agent key. */
export type AuthMethod = "session" | "pat" | "agent";

/**
 * Derive the auth method from the resolved credentials and the identity kind.
 * The bearer precedence mirrors {@link buildUserClient}: an api key (ME_API_KEY)
 * wins when set — a user PAT (`kind: "u"`) or an agent key (`kind: "a"`) — else
 * the human's OAuth session.
 */
export function authMethodOf(
  creds: ResolvedCredentials,
  kind: "u" | "a",
): AuthMethod {
  if (creds.apiKey) return kind === "a" ? "agent" : "pat";
  return "session";
}

/** Human-readable label for an {@link AuthMethod}. */
export function authLabel(method: AuthMethod): string {
  switch (method) {
    case "agent":
      return "agent key";
    case "pat":
      return "api key (PAT)";
    default:
      return "session";
  }
}

/** Space display label — `name (slug)`, with ` [admin]` when the caller is an admin. */
export function formatSpaceLabel(space: MemberSpaceResponse): string {
  return `${space.name} (${space.slug})${space.admin ? " [admin]" : ""}`;
}
