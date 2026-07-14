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

const HARNESS_CONTRACT_ENV_KEYS = [
  "ME_INJECT_V",
  "AI_AGENT",
  "ME_AS_AGENT",
  "ME_PROJECT_DIR",
] as const;

async function withHarnessContractEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of HARNESS_CONTRACT_ENV_KEYS) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of HARNESS_CONTRACT_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
  event: (input: { event: unknown }) => Promise<void>;
  "experimental.session.compacting": (
    input: unknown,
    output: { context: string[] },
  ) => Promise<void>;
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
    const hooks = await loadPlugin(renderPluginSource(), shell);
    const output: { context: string[] } = { context: [] };
    await hooks["experimental.session.compacting"]({}, output);
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("me_memory_search");
  });
});

describe("shell.env — the harness-injected environment contract", () => {
  test("injects all four contract vars, anchored to the session directory", async () => {
    await withHarnessContractEnv({}, async () => {
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
  });

  test("the vars in output.env actually show up in a real subprocess's environment", async () => {
    // OpenCode's own documented contract is merging shell.env's `output.env`
    // into the env of the shell command it's about to run — we don't
    // control or test THAT merge (it's OpenCode's own behavior), but we do
    // control whether the object we hand back actually works as real
    // process env when merged. Prove it by spawning a real process with it
    // merged in and reading back its ACTUAL environment, not just the
    // returned object's shape.
    await withHarnessContractEnv({}, async () => {
      const shell = makeShell();
      const hooks = await loadPlugin(renderPluginSource(), shell, "/my/proj");
      const output: { env?: Record<string, string> } = {};
      await hooks["shell.env"]({}, output);

      const proc = Bun.spawn(["env"], {
        env: { ...process.env, ...output.env },
        stdout: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const env: Record<string, string> = {};
      for (const line of stdout.split("\n")) {
        const idx = line.indexOf("=");
        if (idx !== -1) env[line.slice(0, idx)] = line.slice(idx + 1);
      }
      expect(env.ME_INJECT_V).toBe("1");
      expect(env.AI_AGENT).toBe("opencode");
      expect(env.ME_AS_AGENT).toBe(".me");
      expect(env.ME_PROJECT_DIR).toBe("/my/proj");
    });
  });

  test("preserves any env output already set by another hook", async () => {
    await withHarnessContractEnv({}, async () => {
      const shell = makeShell();
      const hooks = await loadPlugin(renderPluginSource(), shell);
      const output: { env?: Record<string, string> } = { env: { KEPT: "1" } };
      await hooks["shell.env"]({}, output);
      expect(output.env?.KEPT).toBe("1");
      expect(output.env?.ME_AS_AGENT).toBe(".me");
    });
  });

  test("first-writer-wins: emits nothing when the full contract is already live in this process", async () => {
    await withHarnessContractEnv(
      {
        ME_INJECT_V: "1",
        ME_AS_AGENT: ".me",
        ME_PROJECT_DIR: "/other/project",
      },
      async () => {
        const shell = makeShell();
        const hooks = await loadPlugin(renderPluginSource(), shell);
        const output: { env?: Record<string, string> } = {};
        await hooks["shell.env"]({}, output);
        expect(output.env).toBeUndefined();
      },
    );
  });

  test("a PARTIALLY live contract (ME_INJECT_V alone) does NOT trigger first-writer-wins", async () => {
    await withHarnessContractEnv({ ME_INJECT_V: "1" }, async () => {
      const shell = makeShell();
      const hooks = await loadPlugin(renderPluginSource(), shell, "/my/proj");
      const output: { env?: Record<string, string> } = {};
      await hooks["shell.env"]({}, output);
      expect(output.env?.ME_PROJECT_DIR).toBe("/my/proj");
    });
  });
});
