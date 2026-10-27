import { describe, expect, test } from "bun:test";
import { RpcError } from "@memory.build/client";
import { isAuthFailure } from "./auth-failure.ts";

describe("isAuthFailure", () => {
  test("recognises the auth middleware's 401 (string code on the envelope)", () => {
    // What the transport builds from {"error":{"message":…,"code":"UNAUTHORIZED"}}.
    const err = new RpcError(
      "UNAUTHORIZED" as unknown as number,
      "Authentication required (Authorization header or session cookie)",
    );
    expect(isAuthFailure(err)).toBe(true);
  });

  test("recognises a handler-level UNAUTHORIZED (code in data)", () => {
    expect(
      isAuthFailure(new RpcError(-32000, "nope", { code: "UNAUTHORIZED" })),
    ).toBe(true);
  });

  test("is false for other RPC errors and non-RPC errors", () => {
    expect(
      isAuthFailure(new RpcError(-32000, "nope", { code: "FORBIDDEN" })),
    ).toBe(false);
    expect(isAuthFailure(new Error("network"))).toBe(false);
  });
});
