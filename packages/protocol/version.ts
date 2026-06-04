/**
 * Version compatibility schemas — request/response types for the version
 * handshake endpoint.
 *
 * Covers the non-RPC HTTP endpoint used for client/server compatibility
 * checks:
 *   GET /api/v1/version
 *   GET /api/v1/version?clientVersion=<semver>
 *
 * The server is the authority on `minClientVersion`. The client is the
 * authority on `minServerVersion` (it ships its own bound and compares
 * `serverVersion` from the response against it).
 */
import { z } from "zod";

// Header constants (CLIENT_VERSION_HEADER, SPACE_HEADER) live in ./headers.ts.

// =============================================================================
// GET /api/v1/version
// =============================================================================

/**
 * GET /api/v1/version — response body.
 *
 * `client` is populated only when the request supplies the `clientVersion`
 * query parameter. `compatible` is `true` iff the supplied version is
 * `>= minClientVersion`.
 */
export const versionResponseSchema = z.object({
  /** SERVER_VERSION baked into the running server. */
  serverVersion: z.string(),
  /** Oldest CLIENT_VERSION this server will accept. */
  minClientVersion: z.string(),
  /** Compatibility evaluation for the supplied `clientVersion`, if any. */
  client: z
    .object({
      version: z.string(),
      compatible: z.boolean(),
    })
    .optional(),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;
