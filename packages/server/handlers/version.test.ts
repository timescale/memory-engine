import { describe, expect, test } from "bun:test";
import { versionHandler } from "./version";

const handler = versionHandler("0.1.17", "0.2.0");

describe("versionHandler", () => {
  test("returns serverVersion + minClientVersion when no clientVersion supplied", async () => {
    const response = handler(new Request("http://localhost/api/v1/version"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      serverVersion: string;
      minClientVersion: string;
      client?: { version: string; compatible: boolean };
    };
    expect(body.serverVersion).toBe("0.1.17");
    expect(body.minClientVersion).toBe("0.2.0");
    expect(body.client).toBeUndefined();
  });

  test("flags compatible clientVersion >= minClientVersion", async () => {
    const response = handler(
      new Request("http://localhost/api/v1/version?clientVersion=0.2.0"),
    );
    const body = (await response.json()) as {
      client: { version: string; compatible: boolean };
    };
    expect(body.client).toEqual({ version: "0.2.0", compatible: true });
  });

  test("flags compatible clientVersion above minClientVersion", async () => {
    const response = handler(
      new Request("http://localhost/api/v1/version?clientVersion=1.5.2"),
    );
    const body = (await response.json()) as {
      client: { version: string; compatible: boolean };
    };
    expect(body.client.compatible).toBe(true);
  });

  test("flags incompatible clientVersion < minClientVersion", async () => {
    const response = handler(
      new Request("http://localhost/api/v1/version?clientVersion=0.1.99"),
    );
    expect(response.status).toBe(200); // probe always returns 200; result is in body
    const body = (await response.json()) as {
      client: { version: string; compatible: boolean };
    };
    expect(body.client).toEqual({ version: "0.1.99", compatible: false });
  });

  test("treats malformed clientVersion as incompatible", async () => {
    const response = handler(
      new Request("http://localhost/api/v1/version?clientVersion=garbage"),
    );
    const body = (await response.json()) as {
      client: { version: string; compatible: boolean };
    };
    expect(body.client.version).toBe("garbage");
    expect(body.client.compatible).toBe(false);
  });

  test("does not require authentication", () => {
    // No Authorization header — handler should still respond 200.
    const response = handler(new Request("http://localhost/api/v1/version"));
    expect(response.status).toBe(200);
  });
});
