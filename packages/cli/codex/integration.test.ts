import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_ENV_HOOK_COMMAND,
  CODEX_HOOK_ENTRY,
  codexMcpCommand,
  installCodexEnvHook,
  installCodexIntegration,
  removeCodexEnvHook,
  uninstallCodexIntegration,
} from "./integration.ts";

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

test("registers exactly me mcp without any baked targeting", () => {
  expect(codexMcpCommand()).toEqual([
    "codex",
    "mcp",
    "add",
    "me",
    "--",
    "me",
    "mcp",
  ]);
});

test("reports the complete MCP and hook artifact list", async () => {
  const hook = {
    kind: "json-hook" as const,
    path: "/home/test/.codex/hooks.json",
    event: "PreToolUse",
    command: CODEX_ENV_HOOK_COMMAND,
  };
  const result = await installCodexIntegration(undefined, {
    installMcp: async () => ({ success: true, message: "registered" }),
    installHook: () => hook,
  });
  expect(result.artifacts).toEqual([
    { kind: "mcp-cli", server_name: "me" },
    hook,
  ]);
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

test("uninstall removes an entry matching the recorded event and command", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    const artifact = installCodexEnvHook(path);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.hooks.PreToolUse[0].matcher = "^Shell$";
    writeFileSync(path, `${JSON.stringify(config)}\n`);

    expect(removeCodexEnvHook(artifact)).toBe("removed");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { PreToolUse: [] },
    });
  });
});

test("uninstall retains a hook artifact when its configuration is invalid", () => {
  withTmpDir((dir) => {
    const path = join(dir, "hooks.json");
    const artifact = installCodexEnvHook(path);
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: "invalid" } }));

    expect(removeCodexEnvHook(artifact)).toBe("retained");
  });
});

test("uninstall reports artifacts retained when native cleanup fails", async () => {
  const mcp = { kind: "mcp-cli" as const, server_name: "me" as const };
  const hook = {
    kind: "json-hook" as const,
    path: "/home/test/.codex/hooks.json",
    event: "PreToolUse",
    command: CODEX_ENV_HOOK_COMMAND,
  };
  const result = await uninstallCodexIntegration(
    {
      installed_at: "2026-08-03T14:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [mcp, hook],
    },
    {
      removeMcp: async () => false,
      removeHook: () => "retained",
    },
  );
  expect(result.retained).toEqual([mcp, hook]);
});
