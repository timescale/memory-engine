import { describe, expect, test } from "bun:test";
import { checkSizeLimit, MAX_BODY_SIZE } from "./size-limit";

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

  test("MAX_BODY_SIZE is 1MB", () => {
    expect(MAX_BODY_SIZE).toBe(1_048_576);
  });
});
