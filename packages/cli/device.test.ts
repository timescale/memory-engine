/**
 * Tests for the device authorization grant protocol layer (`device.ts`).
 *
 * `fetch` is stubbed with a queue of real `Response`s; `sleep` is injected so
 * the poller runs instantly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pollDeviceToken, startDeviceAuthorization } from "./device.ts";
import { OAuthError } from "./oauth.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub `fetch` with a queue; each call returns the next response in order. */
function queueFetch(responses: ({ status: number; body: unknown } | Error)[]): {
  calls: { url: string; body: unknown; signal?: AbortSignal | null }[];
} {
  const calls: { url: string; body: unknown; signal?: AbortSignal | null }[] =
    [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    });
    const next = responses[i++] ?? responses[responses.length - 1];
    if (!next) throw new Error("no queued response");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls };
}

const noSleep = async () => {};

describe("startDeviceAuthorization", () => {
  test("parses a successful device-code response", async () => {
    const { calls } = queueFetch([
      {
        status: 200,
        body: {
          device_code: "dev-123",
          user_code: "WXYZ-1234",
          verification_uri: "https://api.example.com/device",
          verification_uri_complete:
            "https://api.example.com/device?user_code=WXYZ-1234",
          expires_in: 900,
          interval: 5,
        },
      },
    ]);

    const auth = await startDeviceAuthorization({
      server: "https://api.example.com",
    });

    expect(auth).toEqual({
      deviceCode: "dev-123",
      userCode: "WXYZ-1234",
      verificationUri: "https://api.example.com/device",
      verificationUriComplete:
        "https://api.example.com/device?user_code=WXYZ-1234",
      expiresIn: 900,
      interval: 5,
    });
    // Hits the device/code endpoint under the auth base path with the CLI client.
    expect(calls[0]?.url).toBe(
      "https://api.example.com/api/v1/auth/device/code",
    );
    expect(calls[0]?.body).toEqual({ client_id: "me-cli" });
  });

  test("throws with the server's error_description on failure", async () => {
    queueFetch([
      {
        status: 400,
        body: { error: "invalid_client", error_description: "Unknown client" },
      },
    ]);
    await expect(
      startDeviceAuthorization({ server: "https://api.example.com" }),
    ).rejects.toThrow("Unknown client");
  });

  test("throws on an incomplete response", async () => {
    queueFetch([{ status: 200, body: { device_code: "only-this" } }]);
    await expect(
      startDeviceAuthorization({ server: "https://api.example.com" }),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("pollDeviceToken", () => {
  test("polls through authorization_pending until approval", async () => {
    const sleeps: number[] = [];
    queueFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          access_token: "sess-token",
          token_type: "Bearer",
          expires_in: 604800,
          scope: "",
        },
      },
    ]);

    const tokens = await pollDeviceToken({
      server: "https://api.example.com",
      deviceCode: "dev-123",
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(tokens.accessToken).toBe("sess-token");
    // Device flow yields a session — no refresh token.
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresIn).toBe(604800);
    // Two pending polls → two waits at the base interval (5s).
    expect(sleeps).toEqual([5000, 5000]);
  });

  test("backs off by 5s on slow_down", async () => {
    const sleeps: number[] = [];
    queueFetch([
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "sess-token" } },
    ]);

    await pollDeviceToken({
      server: "https://api.example.com",
      deviceCode: "dev-123",
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([10000]); // 5s + 5s slow_down increment
  });

  test("retries rejected fetches with reduced polling frequency", async () => {
    const sleeps: number[] = [];
    queueFetch([
      new TypeError("network down"),
      { status: 200, body: { access_token: "sess-token" } },
    ]);

    const tokens = await pollDeviceToken({
      server: "https://api.example.com",
      deviceCode: "dev-123",
      interval: 5,
      expiresIn: 900,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(tokens.accessToken).toBe("sess-token");
    expect(sleeps).toEqual([10000]);
  });

  test("passes an abort signal bounded by the device-code lifetime", async () => {
    const { calls } = queueFetch([
      { status: 200, body: { access_token: "sess-token" } },
    ]);

    await pollDeviceToken({
      server: "https://api.example.com",
      deviceCode: "dev-123",
      interval: 5,
      expiresIn: 900,
      sleep: noSleep,
    });

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejected fetches time out before oversleeping the deadline", async () => {
    queueFetch([new TypeError("network down")]);

    await expect(
      pollDeviceToken({
        server: "https://api.example.com",
        deviceCode: "dev-123",
        interval: 5,
        expiresIn: 1,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("throws a clear error when the user denies", async () => {
    queueFetch([{ status: 400, body: { error: "access_denied" } }]);
    await expect(
      pollDeviceToken({
        server: "https://api.example.com",
        deviceCode: "dev-123",
        interval: 5,
        expiresIn: 900,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/denied/i);
  });

  test("throws when the device code expires", async () => {
    queueFetch([{ status: 400, body: { error: "expired_token" } }]);
    await expect(
      pollDeviceToken({
        server: "https://api.example.com",
        deviceCode: "dev-123",
        interval: 5,
        expiresIn: 900,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("times out rather than sleeping past the deadline", async () => {
    // expiresIn 0 → the deadline is already reached after the first pending poll.
    queueFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    await expect(
      pollDeviceToken({
        server: "https://api.example.com",
        deviceCode: "dev-123",
        interval: 5,
        expiresIn: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("surfaces an unexpected error body", async () => {
    queueFetch([
      {
        status: 400,
        body: { error: "invalid_grant", error_description: "Bad device code" },
      },
    ]);
    await expect(
      pollDeviceToken({
        server: "https://api.example.com",
        deviceCode: "dev-123",
        interval: 5,
        expiresIn: 900,
        sleep: noSleep,
      }),
    ).rejects.toThrow("Bad device code");
  });
});
