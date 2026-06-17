import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler, type StaticHandler } from "./static";

let dist: string;
let parent: string;
let handler: StaticHandler;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "me-static-"));
  dist = join(parent, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>x</title></head><body></body></html>",
  );
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
  // A file OUTSIDE the dist root, to prove traversal can't reach it.
  writeFileSync(join(parent, "secret.txt"), "TOP SECRET");
  handler = createStaticHandler({
    webDist: dist,
    bootstrap: { mode: "hosted" },
  });
});

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

function get(path: string, method = "GET"): Promise<Response> {
  return handler.handle(new Request(`http://x${path}`, { method }), path);
}

describe("createStaticHandler", () => {
  test("serves index.html at / with the bootstrap injected", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("window.__ME_BOOTSTRAP__");
    expect(body).toContain('"mode":"hosted"');
    // Injected before </head>.
    expect(body.indexOf("__ME_BOOTSTRAP__")).toBeLessThan(
      body.indexOf("</head>"),
    );
  });

  test("serves a hashed asset with an immutable cache header", async () => {
    const res = await get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("console.log(1)");
  });

  test("falls back to index.html for an extension-less (SPA) route", async () => {
    const res = await get("/memory/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("__ME_BOOTSTRAP__");
  });

  test("404s a missing asset (has an extension)", async () => {
    const res = await get("/assets/missing.js");
    expect(res.status).toBe(404);
  });

  test("does not serve files outside the dist root (path traversal)", async () => {
    const res = await get("/../secret.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  test("HEAD returns headers without a body", async () => {
    const res = await get("/assets/app-abc123.js", "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(await res.text()).toBe("");
  });
});
