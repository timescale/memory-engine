import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  type CliConsentDetails,
  loadCliConsentDetails,
  submitCliConsent,
  validateCliConsentCallback,
} from "./cli-consent.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const details: CliConsentDetails = {
  user: { id: "user-123", email: "person@example.com" },
  clientName: "Memory Engine CLI",
  redirectUri: "http://127.0.0.1:54321/callback",
  scopes: ["openid", "offline_access"],
};
const query =
  "client_id=me-cli&scope=openid+offline_access&sig=a%2Bb%2F&exp=123";

function respond(body: unknown, status = 200) {
  const fetchMock = mock(async (_url: unknown, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("CLI consent API", () => {
  test("loads validated details with cookies and preserves the signed query", async () => {
    const fetchMock = respond(details);
    expect(await loadCliConsentDetails(query)).toEqual(details);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/oauth2/cli-consent-details");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(JSON.stringify({ oauth_query: query }));
  });

  for (const accept of [false, true]) {
    test(`submits ${accept ? "approval" : "denial"} for the displayed account`, async () => {
      const callback = `${details.redirectUri}?${accept ? "code=secret" : "error=access_denied"}&state=original`;
      const fetchMock = respond({ redirect: true, url: callback });
      expect(await submitCliConsent(accept, query, details)).toBe(callback);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/v1/auth/oauth2/consent");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("X-Me-Consent-Account")).toBe(
        "user-123",
      );
      expect(init?.body).toBe(JSON.stringify({ accept, oauth_query: query }));
    });
  }

  for (const [body, status] of [
    [{ message: "Sign in first" }, 401],
    [{ error_description: "The signed query expired" }, 400],
    [{ message: "Client disabled" }, 403],
  ] as const) {
    test(`does not retry a details failure (${status})`, async () => {
      const fetchMock = respond(body, status);
      await expect(loadCliConsentDetails(query)).rejects.toThrow(
        "message" in body ? body.message : body.error_description,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  test("surfaces account changes without retrying a decision", async () => {
    const fetchMock = respond(
      { message: "Account changed. Start again." },
      403,
    );
    await expect(submitCliConsent(true, query, details)).rejects.toThrow(
      "Account changed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed details and non-loopback callback details", async () => {
    for (const body of [
      null,
      {},
      { ...details, user: { email: "person@example.com" } },
      { ...details, scopes: "offline_access" },
      { ...details, redirectUri: "https://attacker.example/callback" },
    ]) {
      respond(body);
      await expect(loadCliConsentDetails(query)).rejects.toThrow();
    }
  });

  test("rejects malformed and unsafe consent responses", async () => {
    for (const body of [
      null,
      {},
      { redirect: false, url: details.redirectUri },
      { redirect: true, url: 123 },
      { redirect: true, url: "https://attacker.example/callback?code=secret" },
    ]) {
      respond(body);
      await expect(submitCliConsent(true, query, details)).rejects.toThrow();
    }
  });

  test("handles a non-JSON error response", async () => {
    globalThis.fetch = (async () =>
      new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(loadCliConsentDetails(query)).rejects.toThrow(
      "may have expired",
    );
  });
});

describe("CLI consent callback validation", () => {
  test("allows response parameters on the exact displayed destination", () => {
    const callback = `${details.redirectUri}?code=secret&state=original`;
    expect(validateCliConsentCallback(callback, details.redirectUri)).toBe(
      callback,
    );
    const ipv6 = "http://[::1]:54321/callback";
    expect(
      validateCliConsentCallback(`${ipv6}?error=access_denied`, ipv6),
    ).toBe(`${ipv6}?error=access_denied`);
  });

  test("preserves callback query parameters while allowing OAuth response parameters", () => {
    const redirect = `${details.redirectUri}?session=a%2Bb`;
    const callback = `${redirect}&code=secret`;
    expect(validateCliConsentCallback(callback, redirect)).toBe(callback);
    expect(() =>
      validateCliConsentCallback(
        `${details.redirectUri}?session=other`,
        redirect,
      ),
    ).toThrow();
    expect(() =>
      validateCliConsentCallback(`${callback}&session=other`, redirect),
    ).toThrow();
  });

  for (const callback of [
    "https://127.0.0.1:54321/callback",
    "http://127.0.0.1:54322/callback",
    "http://127.0.0.1:54321/other",
    "http://127.0.0.2:54321/callback",
    "http://localhost:54321/callback",
    "http://127.0.0.1.attacker.example:54321/callback",
    "http://127.0.0.1:54321@attacker.example/callback",
    "http://user@127.0.0.1:54321/callback",
    "http://127.0.0.1:54321/callback#code=secret",
    "//127.0.0.1:54321/callback",
    "javascript:alert(1)",
    "/callback",
  ]) {
    test(`rejects a different or unsafe callback: ${callback}`, () => {
      expect(() =>
        validateCliConsentCallback(callback, details.redirectUri),
      ).toThrow();
    });
  }
});
