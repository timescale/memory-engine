import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_MARKER, renderPluginSource } from "./plugin-template.ts";

const tmp = mkdtempSync(join(tmpdir(), "me-oc-plugin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeShell() {
  const commands: string[] = [];
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let command = "";
    strings.forEach((string, index) => {
      command += string;
      if (index < values.length) command += String(values[index]);
    });
    commands.push(command.replace(/\s+/g, " ").trim());
    return { quiet: () => ({ nothrow: () => ({}) }) };
  };
  return { $, commands };
}

type Hooks = {
  event: (input: { event: unknown }) => Promise<void>;
  "shell.env": (
    input: unknown,
    output: { env?: Record<string, string> },
  ) => Promise<void>;
};

async function loadPlugin(shell: ReturnType<typeof makeShell>): Promise<Hooks> {
  const file = join(tmp, `plugin-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, renderPluginSource());
  const module = (await import(file)) as {
    MemoryEngine: (context: {
      $: unknown;
      directory: string;
    }) => Promise<Hooks>;
  };
  return module.MemoryEngine({ $: shell.$, directory: "/repo/project" });
}

describe("OpenCode dormant plugin", () => {
  test("has no unconditional recall instruction", () => {
    const source = renderPluginSource();
    expect(source.startsWith(PLUGIN_MARKER)).toBe(true);
    expect(source).not.toContain("experimental.session.compacting");
    expect(source).not.toContain("me_memory_search");
  });

  test("passes the session directory to dormant capture", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(shell);
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands).toEqual([
      "me opencode hook --event idle --session ses_abc --project-dir /repo/project",
    ]);
  });

  test("injects only the frozen shell contract", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(shell);
    const output: { env?: Record<string, string> } = { env: { KEPT: "1" } };
    await hooks["shell.env"]({}, output);
    expect(output.env).toEqual({
      KEPT: "1",
      AI_AGENT: "opencode",
      ME_PROJECT_DIR: "/repo/project",
    });
  });
});
