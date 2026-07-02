/**
 * Tests for the shared capture-hook runner (`agent/capture.ts`).
 *
 * Pure config resolution + the scope-dedup deferral are covered here; the
 * full capture path (credentials → client → import) is exercised by the
 * per-harness hook flows and e2e.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Importer } from "../importers/index.ts";
import {
  type HookCreds,
  parseHookScope,
  resolveHookConfig,
  runCaptureHook,
} from "./capture.ts";

const CREDS: HookCreds = {
  server: "https://api.example.com",
  apiKey: undefined,
  activeSpace: "abc123def456",
  loggedIn: true,
  projectTree: undefined,
  asAgent: undefined,
};

describe("parseHookScope", () => {
  test("project parses; anything else is user (safe deferring side)", () => {
    expect(parseHookScope("project")).toBe("project");
    expect(parseHookScope("user")).toBe("user");
    expect(parseHookScope(undefined)).toBe("user");
    expect(parseHookScope("bogus")).toBe("user");
  });
});

describe("resolveHookConfig", () => {
  test("null without a bearer (no key, not logged in)", () => {
    expect(
      resolveHookConfig({ ...CREDS, loggedIn: false, apiKey: undefined }),
    ).toBeNull();
  });

  test("null without a space", () => {
    expect(resolveHookConfig({ ...CREDS, activeSpace: undefined })).toBeNull();
  });

  test("session path leaves apiKey undefined; carries asAgent through", () => {
    const config = resolveHookConfig({ ...CREDS, asAgent: "my-agent" });
    expect(config).not.toBeNull();
    expect(config?.apiKey).toBeUndefined();
    expect(config?.asAgent).toBe("my-agent");
    expect(config?.space).toBe("abc123def456");
  });

  test("a `.me` projectTree wins unless a tree root is pinned", () => {
    const withProject = resolveHookConfig({
      ...CREDS,
      projectTree: "share.projects.foo",
    });
    expect(withProject?.projectTree).toBe("share.projects.foo");
    expect(withProject?.treeRoot).toBe("share.projects");

    const pinned = resolveHookConfig(
      { ...CREDS, projectTree: "share.projects.foo" },
      { treeRoot: "share.work" },
    );
    expect(pinned?.projectTree).toBeUndefined();
    expect(pinned?.treeRoot).toBe("share.work");
  });

  test("blank/placeholder tree roots are ignored", () => {
    const config = resolveHookConfig(CREDS, { treeRoot: "${tree_root}" });
    expect(config?.treeRoot).toBe("share.projects");
  });
});

describe("runCaptureHook scope dedup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An importer that fails the test if capture proceeds past the dedup gate. */
  const explodingImporter: Importer = {
    tool: "opencode",
    defaultSource: "test",
    // biome-ignore lint/correctness/useYield: never reached in these tests
    async *discoverSessions() {
      throw new Error("discoverSessions should not run");
    },
    parseFile: () => {
      throw new Error("parseFile should not run");
    },
  };

  test("user-scope invocation defers when the project artifact exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-capture-"));
    dirs.push(dir);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const seen: string[] = [];
      await runCaptureHook({
        harness: "opencode",
        event: "idle",
        scope: "user",
        transcriptPath: join(dir, "nope.jsonl"),
        projectCwd: dir,
        importer: explodingImporter,
        projectCaptureInstalled: async (root) => {
          seen.push(root);
          return true;
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("me-capture-");
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("deferring")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("project-scope invocation never consults the dedup detector", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-capture-"));
    dirs.push(dir);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      let consulted = false;
      await runCaptureHook({
        harness: "opencode",
        event: "idle",
        scope: "project",
        // Missing transcript → the capture path logs + returns (best-effort),
        // but the detector must not have gated it.
        transcriptPath: join(dir, "missing.jsonl"),
        projectCwd: dir,
        importer: explodingImporter,
        projectCaptureInstalled: async () => {
          consulted = true;
          return true;
        },
      });
      expect(consulted).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("never throws (best-effort semantics)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "me-capture-"));
    dirs.push(dir);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCaptureHook({
        harness: "claude",
        event: "stop",
        scope: "user",
        transcriptPath: join(dir, "missing.jsonl"),
        projectCwd: dir,
        importer: explodingImporter,
        projectCaptureInstalled: async () => {
          throw new Error("detector blew up");
        },
      });
      // Reaching here without a throw is the assertion.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
