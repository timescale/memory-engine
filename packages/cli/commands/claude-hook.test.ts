/** Black-box inactive-policy coverage for the Claude capture hook. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");

test("Claude capture hook is a silent no-op without a selected local profile", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "me-claude-hook-"));
  try {
    const proc = Bun.spawn(
      [process.execPath, CLI_ENTRY, "claude", "hook", "--event", "stop"],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          ME_PROJECT_DIR: "/unconfigured/project",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(
      JSON.stringify({
        cwd: "/unconfigured/project",
        transcript_path: "/missing/transcript.jsonl",
      }),
    );
    proc.stdin.end();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
