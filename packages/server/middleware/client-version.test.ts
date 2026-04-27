import { describe, expect, test } from "bun:test";
import { CLIENT_VERSION_HEADER } from "@memory.build/protocol";
import { checkClientVersion } from "./client-version";

const MIN = "0.2.0";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/engine/rpc", {
    method: "POST",
    headers,
  });
}

describe("checkClientVersion", () => {
  test("allows requests without the header (lenient mode)", () => {
    const result = checkClientVersion(req(), MIN, true);
    expect(result).toBeNull();
  });

  test("allows requests with a header at the minimum", () => {
    const result = checkClientVersion(
      req({ [CLIENT_VERSION_HEADER]: "0.2.0" }),
      MIN,
      true,
    );
    expect(result).toBeNull();
  });

  test("allows requests with a header above the minimum", () => {
    const result = checkClientVersion(
      req({ [CLIENT_VERSION_HEADER]: "1.0.0" }),
      MIN,
      true,
    );
    expect(result).toBeNull();
  });

  test("rejects requests with a header below the minimum (RPC mode)", async () => {
    const result = checkClientVersion(
      req({ [CLIENT_VERSION_HEADER]: "0.1.0" }),
      MIN,
      true,
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe(426);

    const body = (await result!.json()) as {
      jsonrpc: string;
      error: { code: number; message: string; data?: { code: string } };
      id: string | number | null;
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.data?.code).toBe("CLIENT_VERSION_INCOMPATIBLE");
    expect(body.error.message).toContain("0.1.0");
    expect(body.error.message).toContain("0.2.0");
  });

  test("rejects requests with a header below the minimum (non-RPC mode)", async () => {
    const result = checkClientVersion(
      req({ [CLIENT_VERSION_HEADER]: "0.1.0" }),
      MIN,
      false,
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe(426);

    const body = (await result!.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CLIENT_VERSION_INCOMPATIBLE");
  });

  test("allows requests with a malformed header (lenient on garbage)", () => {
    const result = checkClientVersion(
      req({ [CLIENT_VERSION_HEADER]: "not-a-version" }),
      MIN,
      true,
    );
    // Malformed semver is treated as "unknown" and let through.
    expect(result).toBeNull();
  });
});
