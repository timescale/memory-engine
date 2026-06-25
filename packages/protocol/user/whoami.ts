/**
 * whoami method schema for the user RPC.
 *
 * Returns the identity behind the credential — used by the CLI for `me login`
 * confirmation and `me whoami`. Admits any authenticated principal: a human
 * (session / OAuth / user PAT) reports `kind: "u"` with their email; an agent
 * (acting with its api key) reports `kind: "a"` with a null email (agents have
 * no email). Account-management on the user RPC stays user-only — see the
 * per-method authorization in the server's user handlers.
 */
import { z } from "zod";

// whoami — the authenticated principal's identity
export const whoamiParams = z.object({});
export type WhoamiParams = z.infer<typeof whoamiParams>;

export const whoamiResult = z.object({
  id: z.string(),
  /** The authenticated principal's kind: a user ("u") or an agent ("a"). */
  kind: z.enum(["u", "a"]),
  /** The user's email; null for an agent (agents have no email). */
  email: z.string().nullable(),
  name: z.string(),
});
export type WhoamiResult = z.infer<typeof whoamiResult>;
