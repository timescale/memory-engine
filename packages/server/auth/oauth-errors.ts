/** Fixed, non-sensitive OAuth outcomes shared by HTTP and nested-span telemetry. */
const CLIENT_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);
const SERVER_ERRORS = new Set(["server_error", "temporarily_unavailable"]);

/** Never normalize arbitrary APIErrors, 5xx failures, or unknown error codes. */
export function isExpectedOAuthError(
  status: number,
  error: unknown,
): error is string {
  return (
    (status === 400 || status === 401 || status === 403) &&
    typeof error === "string" &&
    CLIENT_ERRORS.has(error)
  );
}

const REJECTION_REASONS: Record<string, string> = {
  "session not found": "refresh_token_not_found",
  "refresh token not found": "refresh_token_not_found",
  "invalid refresh token": "refresh_token_invalid",
  "refresh token revoked": "refresh_token_revoked",
  "invalid client_id": "client_mismatch",
  "Missing required client_id": "missing_client_id",
  "Missing a required refresh_token for refresh_token grant":
    "missing_refresh_token",
};

/** Descriptions can contain caller-supplied values: emit only a fixed mapping. */
export function oauthErrorTelemetryAttributes(
  status: number,
  error: unknown,
  description?: unknown,
): Record<string, string | boolean> {
  const known =
    typeof error === "string" &&
    (CLIENT_ERRORS.has(error) || SERVER_ERRORS.has(error));
  const attributes: Record<string, string | boolean> = {
    "oauth.grant.outcome": known ? error : "unknown_error",
  };
  if (isExpectedOAuthError(status, error)) {
    attributes["error.expected"] = true;
    attributes["oauth.grant.rejection_reason"] =
      typeof description === "string" &&
      Object.hasOwn(REJECTION_REASONS, description)
        ? (REJECTION_REASONS[description] ?? "other")
        : "other";
  }
  return attributes;
}
