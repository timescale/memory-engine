import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_ENV_HOOK_COMMAND,
  CODEX_HOOK_ENTRY,
  installCodexEnvHook,
  removeCodexEnvHook,
} from "./install.ts";

function withTmpDir<T>(action: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "me-codex-install-"));
  try {
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("records the exact user-global Codex hook artifact", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    expect(installCodexEnvHook(path)).toEqual({
      kind: "json-hook",
      path,
      event: "PreToolUse",
      command: CODEX_ENV_HOOK_COMMAND,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { PreToolUse: [CODEX_HOOK_ENTRY] },
    });
  });
});

test("uninstall removes only the unchanged recorded hook entry", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    const artifact = installCodexEnvHook(path);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.hooks.PreToolUse.push({
      matcher: "^Write$",
      hooks: [{ type: "command", command: "other-hook" }],
    });
    writeFileSync(path, `${JSON.stringify(config)}\n`);

    expect(removeCodexEnvHook(artifact)).toBe("removed");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { PreToolUse: [config.hooks.PreToolUse[1]] },
    });
  });
});

test("uninstall retains a hook entry changed after installation", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    const artifact = installCodexEnvHook(path);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.hooks.PreToolUse[0].matcher = "^Shell$";
    writeFileSync(path, `${JSON.stringify(config)}\n`);

    expect(removeCodexEnvHook(artifact)).toBe("retained");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);
  });
});
