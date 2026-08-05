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

function makePendingShell() {
  const commands: string[] = [];
  let release: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let command = "";
    strings.forEach((string, index) => {
      command += string;
      if (index < values.length) command += String(values[index]);
    });
    commands.push(command.replace(/\s+/g, " ").trim());
    return { quiet: () => ({ nothrow: () => done }) };
  };
  return { $, commands, release: () => release?.() };
}

type Hooks = {
  event: (input: { event: unknown }) => Promise<void>;
  "shell.env": (
    input: unknown,
    output: { env?: Record<string, string> },
  ) => Promise<void>;
};

async function loadPlugin(shell: { $: unknown }): Promise<Hooks> {
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

  test("awaits capture for idle and deleted session events", async () => {
    const source = renderPluginSource();
    expect(source).toContain("const capture = async");
    expect(source).toContain("await $`me opencode hook");
    expect(source).toContain(
      'await capture("idle", event.properties?.sessionID)',
    );
    expect(source).toContain(
      'await capture("deleted", event.properties?.info?.id)',
    );

    for (const event of [
      { type: "session.idle", properties: { sessionID: "ses_idle" } },
      { type: "session.deleted", properties: { info: { id: "ses_deleted" } } },
    ]) {
      const shell = makePendingShell();
      const hooks = await loadPlugin(shell);
      let settled = false;
      const capture = hooks.event({ event }).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      shell.release();
      await capture;
    }
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
