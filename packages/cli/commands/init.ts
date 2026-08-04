/** Machine-local harness policy setup. */
import { Command, InvalidArgumentError } from "commander";
import { parseHarnessName } from "../harness/registry.ts";
import {
  type HarnessProfile,
  writeDefaults,
  writeDirectoryProfile,
} from "../local-config.ts";

function collectHarness(value: string, previous: string[]): string[] {
  parseHarnessName(value);
  return [...previous, value];
}

function harnesses(values: string[]): Record<string, true> {
  return Object.fromEntries(values.map((value) => [value, true]));
}

export function validateInitServer(value: string, option: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError(`${option} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(`${option} must use http(s)`);
  }
  return value;
}

export function createInitCommand(): Command {
  return new Command("init")
    .description("configure machine-local harness policy")
    .argument("[directory]", "directory profile to write")
    .option("--defaults", "write the fallback defaults profile")
    .option("--mcp-server <url>", "MCP server URL")
    .option("--mcp-space <slug>", "lock MCP to this space")
    .option(
      "--mcp-multi-space",
      "leave MCP unpinned so tools require a space (the default without --mcp-space)",
    )
    .option(
      "--mcp-harness <name>",
      "enable MCP for a harness",
      collectHarness,
      [],
    )
    .option("--capture-server <url>", "capture server URL")
    .option("--capture-space <slug>", "capture destination space")
    .option("--capture-tree <path>", "capture tree for a directory profile")
    .option("--capture-tree-root <path>", "capture tree root for defaults")
    .option(
      "--capture-harness <name>",
      "enable capture for a harness",
      collectHarness,
      [],
    )
    .option("--cli-server <url>", "CLI server URL for harness shells")
    .option("--cli-space <slug>", "CLI space for harness shells")
    .option(
      "--cli-harness <name>",
      "enable CLI targeting for a harness",
      collectHarness,
      [],
    )
    .action((directory: string | undefined, opts) => {
      if (directory && opts.defaults) {
        throw new InvalidArgumentError(
          "directory and --defaults are mutually exclusive",
        );
      }
      if (!directory && !opts.defaults) {
        if (!process.stdin.isTTY) {
          throw new InvalidArgumentError(
            "me init requires a directory or --defaults when stdin is not a TTY",
          );
        }
        throw new InvalidArgumentError(
          "choose a directory or --defaults and provide the surface flags to enable",
        );
      }
      if (opts.mcpSpace && opts.mcpMultiSpace) {
        throw new InvalidArgumentError(
          "--mcp-space and --mcp-multi-space conflict",
        );
      }
      if (directory && opts.captureTreeRoot) {
        throw new InvalidArgumentError(
          "--capture-tree-root is only valid with --defaults",
        );
      }
      if (opts.defaults && opts.captureTree) {
        throw new InvalidArgumentError(
          "--capture-tree is only valid for a directory profile",
        );
      }

      const profile: HarnessProfile = {};
      const mcpSelected = opts.mcpHarness.length > 0;
      if (
        mcpSelected ||
        opts.mcpServer ||
        opts.mcpSpace ||
        opts.mcpMultiSpace
      ) {
        if (!mcpSelected || !opts.mcpServer) {
          throw new InvalidArgumentError(
            "enabled MCP requires --mcp-server and --mcp-harness",
          );
        }
        profile.mcp = {
          enabled: true,
          server: validateInitServer(opts.mcpServer, "--mcp-server"),
          ...(opts.mcpSpace ? { space: opts.mcpSpace } : {}),
          harnesses: harnesses(opts.mcpHarness),
        };
      }
      const captureSelected = opts.captureHarness.length > 0;
      if (
        captureSelected ||
        opts.captureServer ||
        opts.captureSpace ||
        opts.captureTree ||
        opts.captureTreeRoot
      ) {
        if (!captureSelected || !opts.captureServer || !opts.captureSpace) {
          throw new InvalidArgumentError(
            "enabled capture requires --capture-server, --capture-space, and --capture-harness",
          );
        }
        if (directory && !opts.captureTree) {
          throw new InvalidArgumentError(
            "directory capture requires --capture-tree",
          );
        }
        if (opts.defaults && !opts.captureTreeRoot) {
          throw new InvalidArgumentError(
            "default capture requires --capture-tree-root",
          );
        }
        profile.capture = {
          enabled: true,
          server: validateInitServer(opts.captureServer, "--capture-server"),
          space: opts.captureSpace,
          ...(opts.captureTree ? { tree: opts.captureTree } : {}),
          ...(opts.captureTreeRoot ? { tree_root: opts.captureTreeRoot } : {}),
          harnesses: harnesses(opts.captureHarness),
        };
      }
      const cliSelected = opts.cliHarness.length > 0;
      if (cliSelected || opts.cliServer || opts.cliSpace) {
        if (!cliSelected || !opts.cliServer) {
          throw new InvalidArgumentError(
            "enabled CLI routing requires --cli-server and --cli-harness",
          );
        }
        profile.cli = {
          server: validateInitServer(opts.cliServer, "--cli-server"),
          ...(opts.cliSpace ? { space: opts.cliSpace } : {}),
          harnesses: harnesses(opts.cliHarness),
        };
      }

      if (opts.defaults) writeDefaults(profile);
      else if (directory) writeDirectoryProfile(directory, profile);
    });
}
