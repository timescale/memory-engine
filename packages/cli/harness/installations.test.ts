import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileMatchesArtifact,
  getInstallation,
  getInstallationsPath,
  readInstallations,
  removeInstallation,
  writeInstallation,
} from "./installations.ts";

function withConfigHome(run: (home: string) => void): void {
  const previous = process.env.XDG_CONFIG_HOME;
  const home = mkdtempSync(join(tmpdir(), "me-installations-"));
  process.env.XDG_CONFIG_HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

const installation = {
  installed_at: "2026-08-03T14:00:00.000Z",
  me_version: "0.0.0",
  artifacts: [
    {
      kind: "mcp-cli" as const,
      server_name: "me" as const,
      scope: "user" as const,
    },
  ],
};

describe("installations inventory", () => {
  test("returns an empty v1 inventory when absent", () => {
    withConfigHome(() =>
      expect(readInstallations()).toEqual({ version: 1, harnesses: {} }),
    );
  });

  test("writes atomically with private file and directory modes", () => {
    withConfigHome(() => {
      writeInstallation("claude", installation);
      const path = getInstallationsPath();
      expect(getInstallation("claude")).toEqual(installation);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
      expect(readFileSync(path, "utf8")).toContain("claude:");
    });
  });

  test("refuses malformed or incompatible existing inventory", () => {
    withConfigHome((home) => {
      const path = join(home, "me", "installations.yaml");
      mkdirSync(join(home, "me"), { recursive: true });
      writeFileSync(path, "version: 2\nharnesses: {}\n");
      expect(() => readInstallations()).toThrow(path);
    });
  });

  test("removes only the requested harness record", () => {
    withConfigHome(() => {
      writeInstallation("claude", installation);
      writeInstallation("codex", installation);
      removeInstallation("claude");
      expect(getInstallation("claude")).toBeUndefined();
      expect(getInstallation("codex")).toEqual(installation);
    });
  });

  test("file ownership requires the recorded sha256", () => {
    withConfigHome((home) => {
      const path = join(home, "managed-file");
      writeFileSync(path, "original");
      const sha256 = createHash("sha256").update("original").digest("hex");
      expect(fileMatchesArtifact({ kind: "file", path, sha256 })).toBe(true);
      writeFileSync(path, "changed");
      expect(fileMatchesArtifact({ kind: "file", path, sha256 })).toBe(false);
    });
  });
});
