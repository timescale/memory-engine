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

type Hooks = {
  // biome-ignore lint/suspicious/noExplicitAny: test harness fires arbitrary event shapes
  event: (input: { event: any }) => Promise<void>;
  "shell.env"?: (
    input: unknown,
    output: { env: Record<string, string> },
  ) => Promise<void>;
};

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

const user = () => renderPluginSource({ scope: "user" });
const project = () => renderPluginSource({ scope: "project" });

describe("renderPluginSource", () => {
  test("carries the managed marker as the first line", () => {
    expect(user().startsWith(PLUGIN_MARKER)).toBe(true);
    expect(project().startsWith(PLUGIN_MARKER)).toBe(true);
  });

  test("custom tree root + full transcript become interpolated array args", () => {
    const src = renderPluginSource({
      scope: "user",
      treeRoot: "share.work",
      fullTranscript: true,
    });
    expect(src).toContain(
      'const EXTRA_ARGS = ["--tree-root","share.work","--full-transcript"]',
    );
    expect(src).toContain("${EXTRA_ARGS}");
  });

  test("default render emits an empty EXTRA_ARGS array (no flags)", () => {
    const src = user();
    expect(src).toContain("const EXTRA_ARGS = []");
    expect(src).not.toContain("--tree-root");
    expect(src).not.toContain("--full-transcript");
  });

  test("default tree root is not emitted as a flag", () => {
    expect(
      renderPluginSource({ scope: "user", treeRoot: "share.projects" }),
    ).toContain("const EXTRA_ARGS = []");
  });

  test("rejects a tree root with shell metacharacters (injection guard)", () => {
    expect(() =>
      renderPluginSource({ scope: "user", treeRoot: "share; rm -rf ~" }),
    ).toThrow(/invalid tree root/);
    expect(() =>
      renderPluginSource({ scope: "user", treeRoot: "a`whoami`" }),
    ).toThrow(/invalid tree root/);
    expect(() =>
      renderPluginSource({ scope: "user", treeRoot: "a b" }),
    ).toThrow(/invalid tree root/);
  });

  test("project scope bakes --as-agent + shell.env; user scope does neither", () => {
    const p = project();
    expect(p).toContain("me --as-agent .me opencode hook --scope project");
    expect(p).toContain('"shell.env"');
    expect(p).toContain('output.env.ME_AS_AGENT = ".me"');

    const u = user();
    expect(u).toContain("me opencode hook --scope user");
    expect(u).not.toContain("--as-agent");
    expect(u).not.toContain("shell.env");
  });
});

describe("generated plugin behavior", () => {
  test("user scope: session.idle captures with --scope user, no agent", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(user(), shell);
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands).toEqual([
      "me opencode hook --scope user --event idle --session ses_abc",
    ]);
  });

  test("project scope: session.idle captures as the agent, --scope project", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(project(), shell);
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands).toEqual([
      "me --as-agent .me opencode hook --scope project --event idle --session ses_abc",
    ]);
  });

  test("session.deleted reads the id from properties.info.id", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(user(), shell);
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_xyz" } },
      },
    });
    expect(shell.commands[0]).toBe(
      "me opencode hook --scope user --event deleted --session ses_xyz",
    );
  });

  test("unrelated events and missing ids are ignored", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(user(), shell);
    await hooks.event({
      event: { type: "session.created", properties: { sessionID: "ses_x" } },
    });
    await hooks.event({ event: { type: "session.idle", properties: {} } });
    expect(shell.commands).toHaveLength(0);
  });

  test("custom flags are present in the emitted command", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(
      renderPluginSource({
        scope: "user",
        treeRoot: "share.work",
        fullTranscript: true,
      }),
      shell,
    );
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_abc" } },
    });
    expect(shell.commands[0]).toBe(
      "me opencode hook --scope user --event idle --session ses_abc --tree-root share.work --full-transcript",
    );
  });

  test("project shell.env hook injects ME_AS_AGENT=.me", async () => {
    const shell = makeShell();
    const hooks = await loadPlugin(project(), shell);
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"]?.({}, output);
    expect(output.env.ME_AS_AGENT).toBe(".me");
  });

  test("compaction hook pushes a memory-recall nudge into the context", async () => {
    const shell = makeShell();
    // biome-ignore lint/suspicious/noExplicitAny: dynamic test module
    const hooks = (await loadPlugin(user(), shell)) as any;
    const output: { context: string[] } = { context: [] };
    await hooks["experimental.session.compacting"]({}, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("me_memory_search");
  });
});
