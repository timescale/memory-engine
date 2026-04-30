import { describe, expect, test } from "bun:test";
import {
  checkSizeLimit,
  DEFAULT_MAX_BODY_SIZE,
  MAX_BODY_SIZE,
  resolveMaxBodySize,
} from "./size-limit";

describe("checkSizeLimit", () => {
  test("allows requests without Content-Length", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
    });
    const result = checkSizeLimit(request);
    expect(result).toBeNull();
  });

  test("allows requests under the size limit", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "1000" },
    });
    const result = checkSizeLimit(request);
    expect(result).toBeNull();
  });

  test("allows requests exactly at the size limit", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": String(MAX_BODY_SIZE) },
    });
    const result = checkSizeLimit(request);
    expect(result).toBeNull();
  });

  test("rejects requests over the size limit", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": String(MAX_BODY_SIZE + 1) },
    });
    const result = checkSizeLimit(request);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(413);
  });

  test("returns correct error body for oversized request", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": String(MAX_BODY_SIZE + 1) },
    });
    const result = checkSizeLimit(request);
    expect(result).not.toBeNull();

    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("handles non-numeric Content-Length gracefully", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "invalid" },
    });
    const result = checkSizeLimit(request);
    // NaN is not > MAX_BODY_SIZE, so it passes through
    expect(result).toBeNull();
  });

  test("respects an explicit `limit` override over the module default", () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "5000" },
    });
    // 4 KiB cap rejects a 5000-byte body even though it's well under the 1 MiB default.
    const result = checkSizeLimit(request, 4096);
    expect(result?.status).toBe(413);
    // And accepts the same body under a generous override.
    const lenient = checkSizeLimit(request, 8192);
    expect(lenient).toBeNull();
  });
});

describe("DEFAULT_MAX_BODY_SIZE", () => {
  test("is 1 MiB", () => {
    expect(DEFAULT_MAX_BODY_SIZE).toBe(1_048_576);
  });
});

describe("resolveMaxBodySize", () => {
  test("returns the default when env is unset", () => {
    expect(resolveMaxBodySize({})).toBe(DEFAULT_MAX_BODY_SIZE);
  });

  test("returns the default when env value is empty", () => {
    expect(resolveMaxBodySize({ MAX_REQUEST_BODY_BYTES: "" })).toBe(
      DEFAULT_MAX_BODY_SIZE,
    );
  });

  test("returns the parsed env value when set", () => {
    expect(resolveMaxBodySize({ MAX_REQUEST_BODY_BYTES: "16777216" })).toBe(
      16_777_216,
    );
  });

  test("throws on a non-numeric env value", () => {
    expect(() =>
      resolveMaxBodySize({ MAX_REQUEST_BODY_BYTES: "lots" }),
    ).toThrow(/positive number/);
  });

  test("throws on zero", () => {
    expect(() => resolveMaxBodySize({ MAX_REQUEST_BODY_BYTES: "0" })).toThrow(
      /positive number/,
    );
  });

  test("throws on a negative value", () => {
    expect(() =>
      resolveMaxBodySize({ MAX_REQUEST_BODY_BYTES: "-100" }),
    ).toThrow(/positive number/);
  });
});
