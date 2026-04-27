import {
  APP_ERROR_CODES,
  applicationError,
  CLIENT_VERSION_HEADER,
} from "@memory.build/protocol";
import { semver } from "bun";
import { error as httpError, json } from "../util/response";

/**
 * Return value of `checkClientVersion`.
 *
 * - `null` means the client version is acceptable (or absent — see below) and
 *   the request should proceed.
 * - A `Response` means the request should be short-circuited with the given
 *   rejection.
 */
export type ClientVersionCheckResult = Response | null;

/**
 * Reject requests whose `X-Client-Version` header is below `minClientVersion`.
 *
 * Lenient on missing header for backward compatibility — clients predating
 * this feature don't send the header and are allowed through. Once everyone
 * has upgraded past `MIN_CLIENT_VERSION`, the bound itself enforces the
 * floor (older clients without the header would have to be older than the
 * floor anyway).
 *
 * Lenient on malformed header — treated as "unknown" and allowed through
 * rather than rejected. Garbage in a header shouldn't take down a request.
 *
 * @param request - The incoming HTTP request.
 * @param minClientVersion - Server's MIN_CLIENT_VERSION.
 * @param isRpc - Whether this request is bound for a JSON-RPC endpoint. RPC
 *                rejections must use the JSON-RPC error envelope so the
 *                client's `RpcError` machinery surfaces a typed `appCode`.
 */
export function checkClientVersion(
  request: Request,
  minClientVersion: string,
  isRpc: boolean,
): ClientVersionCheckResult {
  const header = request.headers.get(CLIENT_VERSION_HEADER);
  if (!header) {
    return null;
  }

  let compatible: boolean;
  try {
    compatible = semver.order(header, minClientVersion) >= 0;
  } catch {
    // Malformed semver — let the request through; the handler will deal with
    // any downstream issue. We don't want to break clients that experiment
    // with the header.
    return null;
  }

  if (compatible) {
    return null;
  }

  const message =
    `Client version ${header} is below the minimum supported version ` +
    `${minClientVersion}. Please upgrade your CLI: ` +
    `https://memory.build/docs/getting-started`;

  if (isRpc) {
    // For RPC endpoints, return a JSON-RPC error envelope so the client's
    // typed RpcError machinery picks it up. The id is unknown here (we
    // haven't parsed the body), so use null per JSON-RPC 2.0 §5.
    return json(
      applicationError(
        null,
        APP_ERROR_CODES.CLIENT_VERSION_INCOMPATIBLE,
        message,
        { minClientVersion, clientVersion: header },
      ),
      // 200 is the canonical JSON-RPC status, but 426 ("Upgrade Required")
      // is the most descriptive HTTP status here. The transport's retry
      // logic doesn't retry 426. Body is still a valid JSON-RPC envelope.
      426,
    );
  }

  return httpError(message, 426, APP_ERROR_CODES.CLIENT_VERSION_INCOMPATIBLE);
}
