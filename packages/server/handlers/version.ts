import type { VersionResponse } from "@memory.build/protocol";
import { semver } from "bun";
import { json } from "../util/response";

/**
 * `GET /api/v1/version` handler.
 *
 * Unauthenticated. Reports the running server version and the oldest client
 * version this server will accept. If the request supplies `?clientVersion=<x>`,
 * the response includes a compatibility evaluation for that version.
 *
 * Used by:
 *   - The CLI (`me version`) for diagnostics.
 *   - The client library to verify compatibility on `me login`.
 *   - CI / monitoring to gate deployments.
 */
export function versionHandler(
  serverVersion: string,
  minClientVersion: string,
): (request: Request) => Response {
  return (request: Request) => {
    const url = new URL(request.url);
    const clientVersion = url.searchParams.get("clientVersion") ?? undefined;

    const body: VersionResponse = {
      serverVersion,
      minClientVersion,
    };

    if (clientVersion !== undefined) {
      // semver.order returns -1 / 0 / 1; treat malformed versions as
      // "incompatible" rather than throwing — clients sending garbage in the
      // query param shouldn't crash the endpoint.
      let compatible = false;
      try {
        compatible = semver.order(clientVersion, minClientVersion) >= 0;
      } catch {
        compatible = false;
      }
      body.client = { version: clientVersion, compatible };
    }

    return json(body);
  };
}
