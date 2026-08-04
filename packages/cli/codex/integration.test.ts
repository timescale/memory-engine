import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CAPTURE_EVENTS,
  CODEX_ENV_HOOK_COMMAND,
  CODEX_HOOK_ENTRY,
  codexCaptureHookCommand,
  codexMcpCommand,
  installCodexEnvHook,
  installCodexIntegration,
  removeCodexEnvHook,
  uninstallCodexIntegration,
} from "./integration.ts";

function captureHook(
  path: string,
  event: (typeof CODEX_CAPTURE_EVENTS)[number],
) {
  return {
    kind: "json-hook" as const,
    path,
    event,
    command: codexCaptureHookCommand(event),
  };
}

async function withTmpDir<T>(
  action: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "me-codex-install-"));
  try {
    return await action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("records the exact user-global Codex hook artifact", async () => {
  await withTmpDir((dir) => {
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

test("installs and removes the dormant Codex capture hooks", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "hooks.json");
    const result = await installCodexIntegration(undefined, {
      hookPath: path,
      installMcp: async () => ({ success: true, message: "registered" }),
    });
    const config = JSON.parse(readFileSync(path, "utf8"));
    for (const event of CODEX_CAPTURE_EVENTS) {
      expect(config.hooks[event]).toEqual([
        {
          matcher: ".*",
          hooks: [
            {
              type: "command",
              command: codexCaptureHookCommand(event),
              timeout: event === "SessionEnd" ? 3 : 10,
            },
          ],
        },
      ]);
    }

    const removed = await uninstallCodexIntegration(
      {
        installed_at: "2026-08-04T00:00:00.000Z",
        me_version: "0.0.0",
        artifacts: result.artifacts,
      },
      {
        removeMcp: async () => true,
      },
    );
    expect(removed.retained).toEqual([]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.Stop).toEqual([]);
    expect(after.hooks.SessionEnd).toEqual([]);
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
    hookPath: hook.path,
    installMcp: async () => ({ success: true, message: "registered" }),
    installHook: () => ({ artifact: hook, changed: true }),
    installCaptureHook: (event) => ({
      artifact: captureHook(hook.path, event),
      changed: true,
    }),
  });
  expect(result.artifacts).toEqual([
    { kind: "mcp-cli", server_name: "me" },
    hook,
    ...CODEX_CAPTURE_EVENTS.map((event) => captureHook(hook.path, event)),
  ]);
});

test("refuses an unrecorded preserved Codex MCP registration", async () => {
  let installedHook = false;
  await expect(
    installCodexIntegration(undefined, {
      hookPath: "/tmp/me-codex-preserved-hooks.json",
      installMcp: async () => ({
        success: true,
        preserved: true,
        message: "already registered",
      }),
      installHook: () => {
        installedHook = true;
        return {
          artifact: {
            kind: "json-hook",
            path: "/tmp/hooks.json",
            event: "PreToolUse",
            command: CODEX_ENV_HOOK_COMMAND,
          },
          changed: true,
        };
      },
      installCaptureHook: (event) => ({
        artifact: captureHook("/tmp/hooks.json", event),
        changed: true,
      }),
    }),
  ).rejects.toThrow("MCP registration is unrecorded");
  expect(installedHook).toBe(false);
});

test("refuses an unrecorded Codex hook before registering MCP", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "hooks.json");
    installCodexEnvHook(path);
    let installedMcp = false;
    await expect(
      installCodexIntegration(undefined, {
        hookPath: path,
        installMcp: async () => {
          installedMcp = true;
          return { success: true, message: "registered" };
        },
      }),
    ).rejects.toThrow("hook in");
    expect(installedMcp).toBe(false);
  });
});

test("preserves all recorded artifacts on a Codex reinstall", async () => {
  await withTmpDir(async (dir) => {
    const hook = {
      kind: "json-hook" as const,
      path: join(dir, "hooks.json"),
      event: "PreToolUse",
      command: CODEX_ENV_HOOK_COMMAND,
    };
    const extra = {
      kind: "file" as const,
      path: join(dir, "legacy.json"),
      sha256: "a".repeat(64),
    };
    const existing = {
      installed_at: "2026-08-04T00:00:00.000Z",
      me_version: "0.0.0",
      artifacts: [
        { kind: "mcp-cli" as const, server_name: "me" as const },
        hook,
        ...CODEX_CAPTURE_EVENTS.map((event) => captureHook(hook.path, event)),
        extra,
      ],
    };

    const result = await installCodexIntegration(existing, {
      hookPath: hook.path,
      installMcp: async () => ({
        success: true,
        preserved: true,
        message: "already registered",
      }),
      installHook: () => ({ artifact: hook, changed: false }),
      installCaptureHook: (event) => ({
        artifact: captureHook(hook.path, event),
        changed: false,
      }),
    });

    expect(result.artifacts).toEqual(existing.artifacts);
  });
});

test("rolls back a new Codex MCP registration when hook installation fails", async () => {
  let removedMcp = false;
  await expect(
    installCodexIntegration(undefined, {
      hookPath: "/tmp/me-codex-read-only-hooks.json",
      installMcp: async () => ({ success: true, message: "registered" }),
      installHook: () => {
        throw new Error("disk is read-only");
      },
      removeMcp: async () => {
        removedMcp = true;
        return true;
      },
      installCaptureHook: (event) => ({
        artifact: captureHook("/tmp/hooks.json", event),
        changed: true,
      }),
    }),
  ).rejects.toThrow("disk is read-only");
  expect(removedMcp).toBe(true);
});

test("uninstall removes only the unchanged recorded hook entry", async () => {
  await withTmpDir((dir) => {
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

test("uninstall removes an entry matching the recorded event and command", async () => {
  await withTmpDir((dir) => {
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

test("uninstall retains a hook artifact when its configuration is invalid", async () => {
  await withTmpDir((dir) => {
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
