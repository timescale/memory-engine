export interface CliConsentDetails {
  user: { id: string; email: string };
  clientName: string;
  redirectUri: string;
  scopes: string[];
}

const AUTH_BASE = "/api/v1/auth/oauth2";
const REQUEST_FAILED =
  "This authorization request could not be verified. It may have expired. Run me login again.";

async function consentCall(
  path: string,
  body: object,
  accountId?: string,
): Promise<unknown> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (accountId !== undefined) headers.set("X-Me-Consent-Account", accountId);
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof result?.error_description === "string"
        ? result.error_description
        : typeof result?.message === "string"
          ? result.message
          : REQUEST_FAILED,
    );
  }
  return result;
}

function loopbackURL(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("The callback must be an HTTP loopback address.");
  }
  return url;
}

export async function loadCliConsentDetails(
  oauthQuery: string,
): Promise<CliConsentDetails> {
  const result = (await consentCall("/cli-consent-details", {
    oauth_query: oauthQuery,
  })) as Partial<CliConsentDetails> | null;
  if (
    !result ||
    typeof result.user?.id !== "string" ||
    !result.user.id ||
    typeof result.user.email !== "string" ||
    typeof result.clientName !== "string" ||
    typeof result.redirectUri !== "string" ||
    !Array.isArray(result.scopes) ||
    !result.scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error(REQUEST_FAILED);
  }
  loopbackURL(result.redirectUri);
  return result as CliConsentDetails;
}

export function validateCliConsentCallback(
  callback: string,
  redirectUri: string,
): string {
  const expected = loopbackURL(redirectUri);
  const actual = loopbackURL(callback);
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname
  ) {
    throw new Error(
      "The callback does not match the address shown. Run me login again.",
    );
  }
  // Keep any query parameters that are part of the displayed callback.
  for (const key of new Set(expected.searchParams.keys())) {
    if (
      JSON.stringify(actual.searchParams.getAll(key)) !==
      JSON.stringify(expected.searchParams.getAll(key))
    ) {
      throw new Error(
        "The callback does not match the address shown. Run me login again.",
      );
    }
  }
  return callback;
}

export async function submitCliConsent(
  accept: boolean,
  oauthQuery: string,
  details: CliConsentDetails,
): Promise<string> {
  const result = (await consentCall(
    "/consent",
    { accept, oauth_query: oauthQuery },
    details.user.id,
  )) as { redirect?: unknown; url?: unknown } | null;
  if (result?.redirect !== true || typeof result.url !== "string") {
    throw new Error(REQUEST_FAILED);
  }
  return validateCliConsentCallback(result.url, details.redirectUri);
}
