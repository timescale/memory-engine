import { describe, expect, test } from "bun:test";
import {
  httpRequestTelemetryAttributes,
  tokenResponseTelemetryAttributes,
} from "./request-telemetry";

describe("httpRequestTelemetryAttributes", () => {
  test("captures bounded client identity only for the OAuth token endpoint", () => {
    const attributes = httpRequestTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token", {
        method: "POST",
        headers: {
          "User-Agent": "memory-engine-cli/0.6.2",
          "X-Me-Client-Instance": "3c718eb6-3dcf-489e-a856-0ee58b6c7848",
          "X-Me-Client-Mode": "mcp",
        },
      }),
    );

    expect(attributes).toEqual({
      "http.method": "POST",
      "http.url": "https://api.memory.build/api/v1/auth/oauth2/token",
      "http.path": "/api/v1/auth/oauth2/token",
      "client.user_agent": "memory-engine-cli/0.6.2",
      "client.instance.id": "3c718eb6-3dcf-489e-a856-0ee58b6c7848",
      "client.mode": "mcp",
    });
  });

  test("does not attach caller identity to other endpoints", () => {
    const attributes = httpRequestTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/memory/rpc", {
        method: "POST",
        headers: {
          "User-Agent": "memory-engine-cli/0.6.2",
          "X-Me-Client-Instance": "instance",
          "X-Me-Client-Mode": "mcp",
        },
      }),
    );

    expect(attributes).toEqual({
      "http.method": "POST",
      "http.url": "https://api.memory.build/api/v1/memory/rpc",
      "http.path": "/api/v1/memory/rpc",
    });
  });

  test("drops oversized token-endpoint identity headers", () => {
    const attributes = httpRequestTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token", {
        headers: {
          "User-Agent": "a".repeat(257),
          "X-Me-Client-Instance": "i".repeat(129),
          "X-Me-Client-Mode": "m".repeat(33),
        },
      }),
    );

    expect(attributes["client.user_agent"]).toBeUndefined();
    expect(attributes["client.instance.id"]).toBeUndefined();
    expect(attributes["client.mode"]).toBeUndefined();
  });

  test("drops token-endpoint identity headers that don't match the expected shape", () => {
    // Bounded length but wrong content — an attacker can't inflate root-span
    // cardinality by spraying arbitrary strings into these attributes.
    const attributes = httpRequestTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token", {
        headers: {
          "User-Agent": "curl/8.4.0",
          "X-Me-Client-Instance": "not-a-uuid",
          "X-Me-Client-Mode": "attacker",
        },
      }),
    );

    expect(attributes["client.user_agent"]).toBeUndefined();
    expect(attributes["client.instance.id"]).toBeUndefined();
    expect(attributes["client.mode"]).toBeUndefined();
  });

  test("accepts each token-endpoint identity header independently of the others", () => {
    // A valid CLI user-agent with a bogus instance/mode still records the UA,
    // and vice versa — validation is per-field.
    const attributes = httpRequestTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token", {
        headers: {
          "User-Agent": "memory-engine-cli/0.6.2",
          "X-Me-Client-Instance": "not-a-uuid",
          "X-Me-Client-Mode": "cli",
        },
      }),
    );
    expect(attributes["client.user_agent"]).toBe("memory-engine-cli/0.6.2");
    expect(attributes["client.instance.id"]).toBeUndefined();
    expect(attributes["client.mode"]).toBe("cli");
  });

  test("classifies invalid_grant as an expected token-grant outcome", async () => {
    const attributes = await tokenResponseTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token"),
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "session not found",
        }),
        { status: 400 },
      ),
    );

    expect(attributes).toEqual({
      "oauth.grant.http_status": "400",
      "oauth.grant.outcome": "invalid_grant",
      "error.expected": true,
    });
  });

  test("classifies successful token grants without parsing their body", async () => {
    const attributes = await tokenResponseTelemetryAttributes(
      new Request("https://api.memory.build/api/v1/auth/oauth2/token"),
      new Response(JSON.stringify({ access_token: "secret" }), { status: 200 }),
    );

    expect(attributes).toEqual({
      "oauth.grant.http_status": "200",
      "oauth.grant.outcome": "success",
    });
  });
});
