/**
 * Stop hook: capture the agent's final response to Memory Engine.
 *
 * Reads hook event JSON from stdin, extracts last_assistant_message,
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
  last_assistant_message: string | null;
  stop_hook_active: boolean;
}

async function deriveProject(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd });
    if (proc.exitCode === 0) {
      const url = new TextDecoder().decode(proc.stdout).trim();
      const match = url.match(/\/([^/]+?)(?:\.git)?$/);
      if (match?.[1]) {
        return match[1].replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
      }
    }
  } catch {
    // fall through to dirname
  }

  const parts = cwd.split("/");
  return (parts[parts.length - 1] || "unknown")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toLowerCase();
}

async function main() {
  const input = await Bun.stdin.text();
  const event: HookEvent = JSON.parse(input);

  // Skip empty or null responses
  if (
    !event.last_assistant_message ||
    event.last_assistant_message.trim().length === 0
  ) {
    process.exit(0);
  }

  const project = await deriveProject(event.cwd);
  const now = new Date().toISOString();

  const meta = JSON.stringify({
    type: "agent_response",
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

  // Pipe response content via stdin
  proc.stdin.write(event.last_assistant_message);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(
      `[memory-engine] capture-response failed (exit ${exitCode}): ${stderr.split("\n")[0]}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[memory-engine] capture-response error: ${err.message}`);
  process.exit(0);
});
