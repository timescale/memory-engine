import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isRpcError } from "./errors.ts";
import { checkServerVersion, compareSemver } from "./version.ts";

describe("compareSemver", () => {
  test("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("0.1.17", "0.1.17")).toBe(0);
  });

  test("orders major versions", () => {
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.99.99", "2.0.0")).toBe(-1);
  });

  test("orders minor versions", () => {
    expect(compareSemver("1.2.0", "1.1.99")).toBe(1);
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
  });

  test("orders patch versions", () => {
    expect(compareSemver("0.1.17", "0.1.16")).toBe(1);
    expect(compareSemver("0.1.16", "0.1.17")).toBe(-1);
  });

  test("strips pre-release suffixes", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-beta", "0.99.0")).toBe(1);
  });

  test("treats missing parts as zero", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  test("treats non-numeric parts as zero", () => {
    expect(compareSemver("1.x.0", "1.0.0")).toBe(0);
  });
});

// =============================================================================
// checkServerVersion — uses globalThis.fetch, so we stub it.
// =============================================================================

const originalFetch = globalThis.fetch;

function mockFetch(handler: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      input instanceof Request
        ? input.url
        : typeof input === "string"
          ? input
          : input.toString();
    const request = new Request(url, init);
    return handler(request);
  }) as typeof fetch;
}

describe("checkServerVersion", () => {
  beforeEach(() => {
    // Reset fetch mock between tests.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("appends ?clientVersion= to the request URL", async () => {
    let capturedUrl = "";
    mockFetch((req) => {
      capturedUrl = req.url;
      return new Response(
        JSON.stringify({
          serverVersion: "0.1.17",
          minClientVersion: "0.2.0",
          client: { version: "0.2.0", compatible: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await checkServerVersion({
      url: "https://api.example.com",
      clientVersion: "0.2.0",
      minServerVersion: "0.1.0",
    });

    expect(capturedUrl).toBe(
      "https://api.example.com/api/v1/version?clientVersion=0.2.0",
    );
  });

  test("returns the parsed body on success", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            serverVersion: "0.1.17",
            minClientVersion: "0.2.0",
            client: { version: "0.2.0", compatible: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const body = await checkServerVersion({
      url: "https://api.example.com",
      clientVersion: "0.2.0",
      minServerVersion: "0.1.0",
    });

    expect(body.serverVersion).toBe("0.1.17");
    expect(body.minClientVersion).toBe("0.2.0");
  });

  test("throws CLIENT_VERSION_INCOMPATIBLE when server flags client", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            serverVersion: "0.5.0",
            minClientVersion: "0.4.0",
            client: { version: "0.1.0", compatible: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      await checkServerVersion({
        url: "https://api.example.com",
        clientVersion: "0.1.0",
        minServerVersion: "0.1.0",
      });
      throw new Error("expected throw");
    } catch (error) {
      if (!isRpcError(error)) throw error;
      expect(error.appCode).toBe("CLIENT_VERSION_INCOMPATIBLE");
      expect(error.message).toContain("0.1.0");
      expect(error.message).toContain("0.4.0");
    }
  });

  test("throws SERVER_VERSION_INCOMPATIBLE when server is below client's minServerVersion", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            serverVersion: "0.0.5",
            minClientVersion: "0.0.1",
            client: { version: "1.0.0", compatible: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      await checkServerVersion({
        url: "https://api.example.com",
        clientVersion: "1.0.0",
        minServerVersion: "0.1.0",
      });
      throw new Error("expected throw");
    } catch (error) {
      if (!isRpcError(error)) throw error;
      expect(error.appCode).toBe("SERVER_VERSION_INCOMPATIBLE");
      expect(error.message).toContain("0.0.5");
      expect(error.message).toContain("0.1.0");
    }
  });

  test("throws on non-2xx HTTP status", async () => {
    mockFetch(
      () =>
        new Response("server error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );

    expect(
      checkServerVersion({
        url: "https://api.example.com",
        clientVersion: "0.2.0",
        minServerVersion: "0.1.0",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("throws SERVER_VERSION_INCOMPATIBLE on HTTP 404 (pre-handshake server)", async () => {
    // Older servers (before /api/v1/version was introduced) return 404 from
    // the version probe. The client should map this to the typed
    // SERVER_VERSION_INCOMPATIBLE app error so the CLI renders an upgrade
    // message rather than a raw "HTTP 404 Not Found".
    mockFetch(
      () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    try {
      await checkServerVersion({
        url: "https://api.example.com",
        clientVersion: "0.2.1",
        minServerVersion: "0.1.17",
      });
      throw new Error("expected throw");
    } catch (error) {
      if (!isRpcError(error)) throw error;
      expect(error.appCode).toBe("SERVER_VERSION_INCOMPATIBLE");
      expect(error.message).toContain("0.2.1");
      expect(error.message).toContain("0.1.17");
      expect(error.message).toContain("/api/v1/version");
      expect(error.data?.serverVersion).toBeNull();
      expect(error.data?.minServerVersion).toBe("0.1.17");
    }
  });
});
