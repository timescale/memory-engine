/**
 * whoami method schema for the user RPC.
 *
 * Returns the identity behind the session token — used by the CLI for `me login`
 * confirmation and `me whoami`. Session-only (an api key never authenticates the
 * user endpoint).
 */
import { z } from "zod";

// whoami — the authenticated user's identity
export const whoamiParams = z.object({});
export type WhoamiParams = z.infer<typeof whoamiParams>;

export const whoamiResult = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
});
export type WhoamiResult = z.infer<typeof whoamiResult>;
