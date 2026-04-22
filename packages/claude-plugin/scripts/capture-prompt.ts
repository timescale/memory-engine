/**
 * UserPromptSubmit hook: capture the user's prompt to Memory Engine.
 *
 * Reads hook event JSON from stdin, extracts the prompt,
 * and shells out to `me memory create`.
 *
 * Best-effort: logs errors to stderr but always exits 0.
 */

const ME_CLI = "me";
const TREE = "poc.claude_code.sessions";
const PLUGIN_VERSION = "0.0.1";

interface HookEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
}

async function deriveProject(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd });
    if (proc.exitCode === 0) {
      const url = new TextDecoder().decode(proc.stdout).trim();
      // Extract repo name from URL: https://github.com/org/repo.git -> repo
      // or git@github.com:org/repo.git -> repo
      const match = url.match(/\/([^/]+?)(?:\.git)?$/);
      if (match?.[1]) {
        // ltree labels: letters, digits, underscores only
        return match[1].replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
      }
    }
  } catch {
    // fall through to dirname
  }

  // Fallback: basename of cwd
  const parts = cwd.split("/");
  return (parts[parts.length - 1] || "unknown")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase();
}

async function main() {
  const input = await Bun.stdin.text();
  const event: HookEvent = JSON.parse(input);

  // Skip empty prompts
  if (!event.prompt || event.prompt.trim().length === 0) {
    process.exit(0);
  }

  const project = await deriveProject(event.cwd);
  const now = new Date().toISOString();

  const meta = JSON.stringify({
    type: "user_prompt",
    session_id: event.session_id,
    project,
    cwd: event.cwd,
    source: "claude-code",
    plugin_version: PLUGIN_VERSION,
  });

  const proc = Bun.spawn(
    [
      ME_CLI,
      "memory",
      "create",
      "--tree",
      TREE,
      "--meta",
      meta,
      "--temporal",
      now,
    ],
    {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  // Pipe prompt content via stdin to avoid shell escaping issues
  proc.stdin.write(event.prompt);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(
      `[memory-engine] capture-prompt failed (exit ${exitCode}): ${stderr.split("\n")[0]}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[memory-engine] capture-prompt error: ${err.message}`);
  process.exit(0);
});
