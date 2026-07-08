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
 * `.quiet().nothrow()` chain the plugin calls. Mirrors Bun `$` enough for our
 * assertions: array interpolations expand space-separated, and incidental
 * whitespace (e.g. an empty `${EXTRA_ARGS}`) is normalized away. */
function makeShell() {
  const commands: string[] = [];
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let cmd = "";
    strings.forEach((s, i) => {
      cmd += s;
      if (i < values.length) {
        const v = values[i];
        cmd += Array.isArray(v) ? v.join(" ") : String(v);
      }
    });
    commands.push(cmd.replace(/\s+/g, " ").trim());
    return { quiet: () => ({ nothrow: () => ({}) }) };
  };
  return { $, commands };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness for the dynamic module
type Hooks = {
  event: (input: { event: any }) => Promise<void>;
  "shell.env": (
    input: unknown,
    output: { env?: Record<string, string> },
  ) => Promise<void>;
};

const TEST_DIRECTORY = "/repo/project";

async function loadPlugin(
  source: string,
  shell: ReturnType<typeof makeShell>,
  directory: string = TEST_DIRECTORY,
): Promise<Hooks> {
  const file = join(tmp, `plugin-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  const mod = (await import(file)) as {
    MemoryEngine: (ctx: { $: unknown; directory: string }) => Promise<Hooks>;
  };
  return mod.MemoryEngine({ $: shell.$, directory });
}

describe("renderPluginSource", () => {
  test("carries the managed marker as the first line", () => {
    expect(renderPluginSource().startsWith(PLUGIN_MARKER)).toBe(true);
  });

  test("full transcript becomes an interpolated array arg", () => {
    const src = renderPluginSource({ fullTranscript: true });
    // Emitted as a JS array literal that Bun `$` interpolates + escapes.
    expect(src).toContain('const EXTRA_ARGS = ["--full-transcript"]');
    expect(src).toContain("${EXTRA_ARGS}");
  });

  test("default render emits an empty EXTRA_ARGS array (no flags)", () => {
    const src = renderPluginSource();
    expect(src).toContain("const EXTRA_ARGS = []");
    expect(src).not.toContain("--tree-root");
    expect(src).not.toContain("--full-transcript");
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
      `me opencode hook --event idle --session ses_abc --project-dir ${TEST_DIRECTORY}`,
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
      `me opencode hook --event deleted --session ses_xyz --project-dir ${TEST_DIRECTORY}`,
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
      renderPluginSource({ fullTranscript: true }),
      shell,
    );
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands[0]).toBe(
      `me opencode hook --event idle --session ses_abc --project-dir ${TEST_DIRECTORY} --full-transcript`,
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

describe("shell.env — the harness-injected environment contract", () => {
  test("injects all four contract vars, anchored to the session directory", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell, "/my/proj");
    const output: { env?: Record<string, string> } = {};
    await hooks["shell.env"]({}, output);
    expect(output.env).toEqual({
      ME_INJECT_V: "1",
      AI_AGENT: "opencode",
      ME_AS_AGENT: ".me",
      ME_PROJECT_DIR: "/my/proj",
    });
  });

  test("preserves any env output already set by another hook", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell);
    const output: { env?: Record<string, string> } = { env: { KEPT: "1" } };
    await hooks["shell.env"]({}, output);
    expect(output.env?.KEPT).toBe("1");
    expect(output.env?.ME_AS_AGENT).toBe(".me");
  });

  test("first-writer-wins: emits nothing when ME_INJECT_V is already live in this process", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(renderPluginSource(), shell);
    const saved = process.env.ME_INJECT_V;
    process.env.ME_INJECT_V = "1";
    try {
      const output: { env?: Record<string, string> } = {};
      await hooks["shell.env"]({}, output);
      expect(output.env).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ME_INJECT_V;
      else process.env.ME_INJECT_V = saved;
    }
  });
});
