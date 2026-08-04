/** Local harness-policy diagnostics. */
import { Command } from "commander";
import { readShapeLog } from "../harness-shape-log.ts";
import { resolveHarnessProfile } from "../local-config.ts";
import { getOutputFormat, output } from "../output.ts";

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("diagnose local harness policy")
    .argument("[directory]", "directory to inspect", process.cwd())
    .action((directory: string, _opts, cmd) => {
      const profile = resolveHarnessProfile(directory);
      const shapes = readShapeLog();
      const global = cmd.optsWithGlobals();
      output(
        { profile, unrecognizedHarnessPayloads: shapes },
        getOutputFormat(global),
        () => {
          console.log(`  Directory: ${profile.cwd}`);
          console.log(`  Profile:   ${profile.profile_source}`);
          console.log(`  MCP:       ${profile.mcp.source}`);
          console.log(`  Capture:   ${profile.capture.source}`);
          if (shapes.length > 0) {
            console.log(
              `  Warnings:  ${shapes.length} unrecognized harness payload shape(s)`,
            );
          }
        },
      );
    });
}
