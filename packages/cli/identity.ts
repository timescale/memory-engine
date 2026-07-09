/**
 * Shared identity/space formatting for `me whoami` and `me login`.
 *
 * These pure helpers keep the two commands' output in lockstep — the space
 * label (`name (slug)` + an admin marker) and the auth-method descriptor
 * (session vs api key vs agent/service-account key) render identically wherever
 * an identity is shown.
 */
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import type { ResolvedCredentials } from "./credentials.ts";

/** How the caller authenticated: session, user PAT, agent key, or service-account key. */
export type AuthMethod = "session" | "pat" | "agent" | "service-account";

/**
 * Derive the auth method from the resolved credentials and the identity kind.
 * The bearer precedence mirrors {@link buildUserClient}: an api key (ME_API_KEY)
 * wins when set — a user PAT (`kind: "u"`), agent key (`kind: "a"`), or service
 * account key (`kind: "s"`) — else the human's OAuth session.
 */
export function authMethodOf(
  creds: ResolvedCredentials,
  kind: "u" | "a" | "s",
): AuthMethod {
  if (creds.apiKey) {
    if (kind === "a") return "agent";
    if (kind === "s") return "service-account";
    return "pat";
  }
  return "session";
}

/** Human-readable label for an {@link AuthMethod}. */
export function authLabel(method: AuthMethod): string {
  switch (method) {
    case "agent":
      return "agent key";
    case "service-account":
      return "service-account key";
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
