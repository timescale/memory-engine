/**
 * Behavior tests for the generated OpenCode plugin.
 *
 * Rather than assert on the template string, we materialize the rendered source
 * to a temp module, import it, and fire fake OpenCode events at it with a mock
 * Bun `$` — so the test catches event-shape mistakes (e.g. the `session.deleted`
 * payload nests the id under `properties.info.id`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_MARKER, renderPluginSource } from "./plugin-template.ts";

const tmp = mkdtempSync(join(tmpdir(), "me-oc-plugin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A mock Bun `$` that records the reconstructed command and supports the
 * `.quiet().nothrow()` chain the plugin calls. */
function makeShell() {
  const commands: string[] = [];
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let cmd = "";
    strings.forEach((s, i) => {
      cmd += s;
      if (i < values.length) cmd += String(values[i]);
    });
    commands.push(cmd);
    return { quiet: () => ({ nothrow: () => ({}) }) };
  };
  return { $, commands };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness for the dynamic module
type Hooks = { event: (input: { event: any }) => Promise<void> };

async function loadPlugin(
  source: string,
  shell: ReturnType<typeof makeShell>,
): Promise<Hooks> {
  const file = join(tmp, `plugin-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  const mod = (await import(file)) as {
    MemoryEngine: (ctx: { $: unknown }) => Promise<Hooks>;
  };
  return mod.MemoryEngine({ $: shell.$ });
}

describe("renderPluginSource", () => {
  test("carries the managed marker as the first line", () => {
    expect(renderPluginSource().startsWith(PLUGIN_MARKER)).toBe(true);
  });

  test("default render has no --tree-root / --full-transcript flags", () => {
    const src = renderPluginSource();
    expect(src).not.toContain("--tree-root");
    expect(src).not.toContain("--full-transcript");
  });

  test("custom tree root + full transcript are spliced into the command", () => {
    const src = renderPluginSource({
      treeRoot: "share.work",
      fullTranscript: true,
    });
    // The validated value is single-quoted so it can't break the shell command.
    expect(src).toContain("--tree-root 'share.work'");
    expect(src).toContain("--full-transcript");
  });

  test("default tree root is not emitted as a flag", () => {
    expect(renderPluginSource({ treeRoot: "share.projects" })).not.toContain(
      "--tree-root",
    );
  });

  test("rejects a tree root with shell metacharacters (injection guard)", () => {
    expect(() => renderPluginSource({ treeRoot: "share; rm -rf ~" })).toThrow(
      /invalid tree root/,
    );
    expect(() => renderPluginSource({ treeRoot: "a`whoami`" })).toThrow(
      /invalid tree root/,
    );
    expect(() => renderPluginSource({ treeRoot: "a b" })).toThrow(
      /invalid tree root/,
    );
  });
});

describe("generated plugin behavior", () => {
  test("session.idle captures with the session id", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell);
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]).toBe(
      "me opencode hook --event idle --session ses_abc",
    );
  });

  test("session.deleted reads the id from properties.info.id", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell);
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_xyz" } },
      },
    });
    expect(shell.commands[0]).toBe(
      "me opencode hook --event deleted --session ses_xyz",
    );
  });

  test("unrelated events and missing ids are ignored", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell);
    await hooks.event({
      event: { type: "session.created", properties: { sessionID: "ses_x" } },
    });
    await hooks.event({ event: { type: "session.idle", properties: {} } });
    expect(shell.commands).toHaveLength(0);
  });

  test("custom flags are present in the emitted command", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(
      renderPluginSource({ treeRoot: "share.work", fullTranscript: true }),
      shell,
    );
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands[0]).toBe(
      "me opencode hook --event idle --session ses_abc --tree-root 'share.work' --full-transcript",
    );
  });

  test("compaction hook pushes a memory-recall nudge into the context", async () => {
    const shell = makeShell();
    // biome-ignore lint/suspicious/noExplicitAny: dynamic test module
    const hooks = (await loadPlugin(renderPluginSource(), shell)) as any;
    const output: { context: string[] } = { context: [] };
    await hooks["experimental.session.compacting"]({}, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("me_memory_search");
  });
});
