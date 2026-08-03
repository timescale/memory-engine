import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessInstallation } from "../harness/installations.ts";
import { uninstallOpenCodeArtifacts } from "./opencode.ts";

function record(path: string): HarnessInstallation {
  return {
    installed_at: "2026-08-03T14:00:00.000Z",
    me_version: "0.0.0",
    artifacts: [{ kind: "mcp-json", path, server_name: "me" }],
  };
}

describe("OpenCode uninstall", () => {
  test("removes only mcp.me and preserves unrelated entries", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "me-opencode-")),
      "opencode.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        mcp: {
          me: { type: "local", command: ["me", "mcp"] },
          other: { command: ["other"] },
        },
        theme: "dark",
      }),
    );

    const result = await uninstallOpenCodeArtifacts(record(path));

    expect(result.retained).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcp: { other: { command: ["other"] } },
      theme: "dark",
    });
  });

  test("does not leave an empty mcp object", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "me-opencode-")),
      "opencode.json",
    );
    writeFileSync(
      path,
      JSON.stringify({
        mcp: { me: { type: "local", command: ["me", "mcp"] } },
        theme: "dark",
      }),
    );

    await uninstallOpenCodeArtifacts(record(path));

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark" });
  });

  test("retains a modified generated file", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "me-opencode-")),
      "memory-engine.ts",
    );
    writeFileSync(path, "modified");
    const result = await uninstallOpenCodeArtifacts({
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [
        {
          kind: "file",
          path,
          sha256: createHash("sha256").update("original").digest("hex"),
        },
      ],
    });

    expect(result.removed).toEqual([]);
    expect(result.retained).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("modified");
  });
});
