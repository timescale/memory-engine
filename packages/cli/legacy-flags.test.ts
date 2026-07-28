/**
 * Compatibility guarantees for TNT-244 phase 2: the retired act-as-agent
 * surfaces (the `--as-agent` root option and its companion `ME_AS_AGENT`
 * env) must NOT resurrect quietly. `credentials.test.ts` covers the
 * ME_AS_AGENT env case at the resolver level; this file covers the
 * argv-parsing surface with a real CLI spawn so a stray `--as-agent` flag
 * fails loudly rather than being silently ignored.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "index.ts");

/** Spawn the CLI with argv + env; return exit code + captured streams. */
async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...argv], {
    env: {
      ...process.env,
      // Isolate from any ambient contract the outer harness may have injected;
      // an unrelated ME_AS_AGENT survives elsewhere but should never affect
      // argv parsing here.
      ME_AS_AGENT: undefined,
      AI_AGENT: undefined,
      ME_PROJECT_DIR: undefined,
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("removed --as-agent root option", () => {
  test("errors as an unknown option (never silently accepted)", async () => {
    // `me --as-agent x whoami` used to run whoami as agent 'x'. After phase 2
    // it must fail commander's argv parse — no code path should still exist
    // that treats --as-agent as a live flag.
    const { exitCode, stderr } = await runCli(["--as-agent", "x", "whoami"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("unknown option");
    expect(stderr).toContain("--as-agent");
  });
});
