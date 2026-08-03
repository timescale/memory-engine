import { describe, expect, test } from "bun:test";
import {
  createHarnessUninstallCommand,
  createUninstallCommand,
  uninstallHarnessAndPurge,
} from "./install.ts";

describe("harness uninstall", () => {
  test("exposes --purge on aggregate and per-harness commands", () => {
    expect(
      createUninstallCommand().options.map((option) => option.long),
    ).toContain("--purge");
    expect(
      createHarnessUninstallCommand("claude").options.map(
        (option) => option.long,
      ),
    ).toContain("--purge");
  });

  test("purges local policy only after native uninstall succeeds", async () => {
    const removed: string[] = [];
    await uninstallHarnessAndPurge(
      "claude",
      true,
      async () => false,
      (name) => removed.push(name),
    );
    expect(removed).toEqual([]);

    await uninstallHarnessAndPurge(
      "claude",
      true,
      async () => true,
      (name) => removed.push(name),
    );
    expect(removed).toEqual(["claude"]);
  });
});
