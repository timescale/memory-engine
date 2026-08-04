/** Local harness-policy diagnostics. */
import { Command } from "commander";
import { HARNESS_NAMES, type HarnessName } from "../harness/names.ts";
import { readShapeLog } from "../harness-shape-log.ts";
import {
  type CaptureSurface,
  type CliSurface,
  type HarnessSelection,
  type McpSurface,
  type ResolvedHarnessProfile,
  type ResolvedSurface,
  resolveHarnessProfile,
} from "../local-config.ts";
import { getOutputFormat, output } from "../output.ts";

/** The harnesses a surface's `harnesses` map selects (value `true`). */
function selectedHarnesses(harnesses: HarnessSelection): HarnessName[] {
  return HARNESS_NAMES.filter((name) => harnesses[name] === true);
}

/** Human label for the profile a surface was resolved from. */
function profileLabel(profile: ResolvedHarnessProfile): string {
  return profile.profile_source === "directory"
    ? `directory profile (${profile.profile_path})`
    : "defaults profile";
}

/** Reason wording for a surface that is absent from the matched profile. */
function absentReason(
  surface: "mcp" | "capture" | "cli",
  profile: ResolvedHarnessProfile,
): string {
  return profile.profile_source === "directory"
    ? `no \`${surface}\` block in the matched directory profile (${profile.profile_path})`
    : `no matched directory profile exists and the defaults profile has no \`${surface}\` block`;
}

/** Diagnosis of an `enabled`-gated surface (`mcp` / `capture`). */
interface EnabledSurfaceDiagnosis {
  active: boolean;
  reason: string;
  harnesses: HarnessName[];
  server?: string;
  space?: string;
  multiSpace?: boolean;
  tree?: string;
  treeRoot?: string;
}

function diagnoseEnabledSurface(
  name: "mcp" | "capture",
  surface: ResolvedSurface<McpSurface | CaptureSurface>,
  profile: ResolvedHarnessProfile,
): EnabledSurfaceDiagnosis {
  if (surface.source === "disabled" || surface.value === undefined) {
    return {
      active: false,
      reason: absentReason(name, profile),
      harnesses: [],
    };
  }
  const value = surface.value;
  const where = profileLabel(profile);
  if (!value.enabled) {
    return {
      active: false,
      reason: `\`${name}.enabled\` is false in the ${where}`,
      harnesses: [],
    };
  }
  const harnesses = selectedHarnesses(value.harnesses);
  if (harnesses.length === 0) {
    return {
      active: false,
      reason: `\`${name}\` is enabled in the ${where} but selects no harness`,
      harnesses: [],
    };
  }
  const base: EnabledSurfaceDiagnosis = {
    active: true,
    reason: `enabled in the ${where}`,
    harnesses,
    server: value.server,
  };
  if (name === "mcp") {
    return value.space
      ? { ...base, space: value.space }
      : { ...base, multiSpace: true };
  }
  const capture = value as CaptureSurface;
  return {
    ...base,
    ...(capture.space ? { space: capture.space } : {}),
    ...(capture.tree ? { tree: capture.tree } : {}),
    ...(capture.tree_root ? { treeRoot: capture.tree_root } : {}),
  };
}

/** Diagnosis of the (enableless) `cli` surface. */
interface CliDiagnosis {
  configured: boolean;
  reason: string;
  harnesses: HarnessName[];
  server?: string;
  space?: string;
}

function diagnoseCli(
  surface: ResolvedSurface<CliSurface>,
  profile: ResolvedHarnessProfile,
): CliDiagnosis {
  if (surface.source === "disabled" || surface.value === undefined) {
    return {
      configured: false,
      reason: absentReason("cli", profile),
      harnesses: [],
    };
  }
  const harnesses = selectedHarnesses(surface.value.harnesses);
  if (harnesses.length === 0) {
    return {
      configured: false,
      reason: `\`cli\` present in the ${profileLabel(profile)} but selects no harness`,
      harnesses: [],
    };
  }
  return {
    configured: true,
    reason: `configured in the ${profileLabel(profile)}`,
    harnesses,
    server: surface.value.server,
    ...(surface.value.space ? { space: surface.value.space } : {}),
  };
}

/** How the CLI would be targeted in the CURRENT shell's harness context. */
type CliRouting =
  | { inHarness: false; note: string }
  | {
      inHarness: true;
      agent: HarnessName;
      routed: true;
      server?: string;
      space?: string;
    }
  | { inHarness: true; agent: HarnessName; routed: false; note: string };

function diagnoseHarnessContext(surface: ResolvedSurface<CliSurface>): {
  agent: string | null;
  cliRouting: CliRouting;
} {
  const agent = process.env.AI_AGENT ?? null;
  if (!agent || !HARNESS_NAMES.includes(agent as HarnessName)) {
    return {
      agent,
      cliRouting: {
        inHarness: false,
        note: "no harness context in this shell; user CLI is never retargeted by directory profiles",
      },
    };
  }
  const name = agent as HarnessName;
  const value = surface.source === "disabled" ? undefined : surface.value;
  if (value && value.harnesses[name] === true) {
    return {
      agent,
      cliRouting: {
        inHarness: true,
        agent: name,
        routed: true,
        server: value.server,
        ...(value.space ? { space: value.space } : {}),
      },
    };
  }
  return {
    agent,
    cliRouting: {
      inHarness: true,
      agent: name,
      routed: false,
      note: "falls back to user CLI (this harness not selected under `cli.harnesses`)",
    },
  };
}

function enabledSurfaceLine(d: EnabledSurfaceDiagnosis): string {
  if (!d.active) return `inactive — ${d.reason}`;
  const parts = [`harnesses: ${d.harnesses.join(", ")}`];
  if (d.server) parts.push(`server: ${d.server}`);
  if (d.multiSpace) parts.push("space: (multi-space)");
  else if (d.space) parts.push(`space: ${d.space}`);
  if (d.tree) parts.push(`tree: ${d.tree}`);
  if (d.treeRoot) parts.push(`tree_root: ${d.treeRoot}`);
  return `active — ${parts.join("; ")}`;
}

function cliSurfaceLine(d: CliDiagnosis): string {
  if (!d.configured) return `not configured — ${d.reason}`;
  const parts = [`harnesses: ${d.harnesses.join(", ")}`];
  if (d.server) parts.push(`server: ${d.server}`);
  if (d.space) parts.push(`space: ${d.space}`);
  return `configured — ${parts.join("; ")}`;
}

function harnessContextLine(agent: string | null, routing: CliRouting): string {
  if (!routing.inHarness) return `none (user shell) — ${routing.note}`;
  if (routing.routed) {
    const target = [`server: ${routing.server ?? "(unset)"}`];
    if (routing.space) target.push(`space: ${routing.space}`);
    else target.push("space: (multi-space)");
    return `${agent} — CLI-in-harness routes to ${target.join("; ")}`;
  }
  return `${agent} — ${routing.note}`;
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("diagnose local harness policy")
    .argument(
      "[directory]",
      "directory to inspect (default: ME_PROJECT_DIR, else the current directory)",
    )
    .action((directory: string | undefined, _opts, cmd) => {
      // Emulate the dispatcher/hook anchor (`ME_PROJECT_DIR ?? cwd`) when no
      // directory is passed; an explicit argument overrides it.
      const anchorSource = directory
        ? "argument"
        : process.env.ME_PROJECT_DIR
          ? "ME_PROJECT_DIR"
          : "cwd";
      const anchorRaw =
        directory ?? process.env.ME_PROJECT_DIR ?? process.cwd();
      const profile = resolveHarnessProfile(anchorRaw);
      const shapes = readShapeLog();

      const mcp = diagnoseEnabledSurface("mcp", profile.mcp, profile);
      const capture = diagnoseEnabledSurface(
        "capture",
        profile.capture,
        profile,
      );
      const cli = diagnoseCli(profile.cli, profile);
      const { agent, cliRouting } = diagnoseHarnessContext(profile.cli);

      const global = cmd.optsWithGlobals();
      output(
        {
          anchor: {
            source: anchorSource,
            raw: anchorRaw,
            canonical: profile.cwd,
          },
          profile_source: profile.profile_source,
          ...(profile.profile_path === undefined
            ? {}
            : { profile_path: profile.profile_path }),
          surfaces: { mcp, capture, cli },
          harnessContext: { agent, cliRouting },
          unrecognizedHarnessPayloads: shapes,
        },
        getOutputFormat(global),
        () => {
          console.log(`  Anchor:    ${anchorRaw} (${anchorSource})`);
          console.log(`  Resolved:  ${profile.cwd}`);
          console.log(
            `  Profile:   ${
              profile.profile_source === "directory"
                ? `directory (${profile.profile_path})`
                : "defaults (no directory profile matched)"
            }`,
          );
          console.log(`  MCP:       ${enabledSurfaceLine(mcp)}`);
          console.log(`  Capture:   ${enabledSurfaceLine(capture)}`);
          console.log(`  CLI:       ${cliSurfaceLine(cli)}`);
          console.log(`  Harness:   ${harnessContextLine(agent, cliRouting)}`);
          if (shapes.length > 0) {
            console.log(
              `  Warnings:  ${shapes.length} unrecognized harness payload shape(s)`,
            );
          }
        },
      );
    });
}
