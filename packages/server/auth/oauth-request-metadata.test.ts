import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tokenRequestTelemetryAttributes } from "./oauth-request-metadata";

const URL = "https://api.example.com/api/v1/auth/oauth2/token";
const form = (body: string, headers: Record<string, string> = {}) =>
  new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });

describe("safe token request diagnostics", () => {
  test("records only grant type and known public client, preserving the original body", async () => {
    const body =
      "grant_type=refresh_token&client_id=me-cli&refresh_token=refresh-secret&client_secret=client-secret&code=private-code&code_verifier=private-verifier";
    const request = form(body);
    expect(await tokenRequestTelemetryAttributes(request)).toEqual({
      "oauth.grant.type": "refresh_token",
      "oauth.client_id": "me-cli",
    });
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe(body);
  });

  test("hashes unknown public client IDs rather than copying arbitrary strings", async () => {
    const client = "other-client";
    const attributes = await tokenRequestTelemetryAttributes(
      form(`grant_type=refresh_token&client_id=${client}`),
    );
    expect(attributes).toEqual({
      "oauth.grant.type": "refresh_token",
      "oauth.client_id": "other",
      "oauth.client_id_hash": createHash("sha256").update(client).digest("hex"),
    });
    expect(JSON.stringify(attributes)).not.toContain(client);
  });

  test("JSON requests ignore credential fields, nonscalar fields and hostile values", async () => {
    const attributes = await tokenRequestTelemetryAttributes(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "private-grant",
          client_id: "secret\nclient",
          refresh_token: "refresh-secret",
          client_secret: "client-secret",
        }),
      }),
    );
    expect(attributes).toEqual({ "oauth.grant.type": "other" });
    expect(
      await tokenRequestTelemetryAttributes(
        new Request(URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: [], client_id: {} }),
        }),
      ),
    ).toEqual({});
  });

  test("omits ambiguous, oversized or invalid fields", async () => {
    expect(
      await tokenRequestTelemetryAttributes(
        form(
          "grant_type=refresh_token&grant_type=authorization_code&client_id=me-cli&client_id=other",
        ),
      ),
    ).toEqual({});
    expect(
      await tokenRequestTelemetryAttributes(
        form(`client_id=${"a".repeat(129)}`),
      ),
    ).toEqual({});
    expect(
      await tokenRequestTelemetryAttributes(
        new Request(URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not JSON",
        }),
      ),
    ).toEqual({});
  });

  test("reads only small bodies and never consumes the handler's original stream", async () => {
    const cases: Record<string, string>[] = [{}, { "content-length": "10000" }];
    for (const headers of cases) {
      const body = `grant_type=refresh_token&client_id=me-cli&padding=${"x".repeat(9000)}`;
      const request = form(body, headers);
      expect(await tokenRequestTelemetryAttributes(request)).toEqual({});
      expect(await request.text()).toBe(body);
    }
    const used = form("client_id=me-cli");
    await used.text();
    expect(await tokenRequestTelemetryAttributes(used)).toEqual({});
  });

  test("stalled metadata branches time out without consuming the original branch", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream<Uint8Array>(),
    });
    expect(await tokenRequestTelemetryAttributes(request)).toEqual({});
    expect(request.bodyUsed).toBe(false);
    await request.body?.cancel();
  });

  test("does not clone other endpoints, methods, unsupported types or oversized declared bodies", async () => {
    for (const request of [
      new Request("https://api.example.com/api/v1/memory/rpc", {
        method: "POST",
        body: "private-body",
      }),
      new Request(URL),
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "private-body",
      }),
      form("client_id=me-cli", { "content-length": "9000" }),
    ]) {
      let clones = 0;
      Object.defineProperty(request, "clone", {
        value: () => {
          clones++;
          throw new Error("should not clone");
        },
      });
      expect(await tokenRequestTelemetryAttributes(request)).toEqual({});
      expect(clones).toBe(0);
      expect(request.bodyUsed).toBe(false);
    }
  });
});
