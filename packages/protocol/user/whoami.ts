/**
 * whoami method schema for the user RPC.
 *
 * Returns the identity behind the credential — used by the CLI for `me login`
 * confirmation and `me whoami`. Admits any authenticated principal: a human
 * (session / OAuth / user PAT) reports `kind: "u"` with their email; an agent or
 * service account (acting with its api key) reports `kind: "a"` or `kind: "s"`
 * with a null email. Account-management on the user RPC stays user-only — see
 * the per-method authorization in the server's user handlers.
 */
import { z } from "zod";

// whoami — the authenticated principal's identity
export const whoamiParams = z.object({});
export type WhoamiParams = z.infer<typeof whoamiParams>;

export const whoamiResult = z.object({
  id: z.string(),
  /** The authenticated principal's kind: a user, agent, or service account. */
  kind: z.enum(["u", "a", "s"]),
  /** The user's email; null for agents and service accounts. */
  email: z.string().nullable(),
  name: z.string(),
});
export type WhoamiResult = z.infer<typeof whoamiResult>;
