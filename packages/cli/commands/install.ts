/** Mechanical command facade for harness installation inventory. */
import { Command } from "commander";
import {
  getHarness,
  HARNESS_NAMES,
  type HarnessName,
  installHarness,
  resolveHarnessTargets,
  uninstallHarness,
} from "../harness/registry.ts";
import { removeHarnessFromProfiles } from "../local-config.ts";

export async function uninstallHarnessAndPurge(
  name: HarnessName,
  purge: boolean,
  uninstall: (target: HarnessName) => Promise<boolean> = uninstallHarness,
  removeFromProfiles: (target: HarnessName) => void = removeHarnessFromProfiles,
): Promise<void> {
  if (await uninstall(name)) {
    if (purge) removeFromProfiles(name);
  }
}

export function createInstallCommand(): Command {
  return new Command("install")
    .description("install Memory Engine's dormant harness integrations")
    .argument("[harness...]", `harnesses (${HARNESS_NAMES.join(", ")})`)
    .action(async (values: string[]) => {
      for (const name of resolveHarnessTargets(values, true)) {
        await installHarness(name);
      }
    });
}

export function createUninstallCommand(): Command {
  return new Command("uninstall")
    .description("uninstall recorded Memory Engine harness integrations")
    .argument("[harness...]", `harnesses (${HARNESS_NAMES.join(", ")})`)
    .option("--purge", "remove the harness from local activation profiles")
    .action(async (values: string[], opts: { purge?: boolean }) => {
      for (const name of resolveHarnessTargets(values, false)) {
        await uninstallHarnessAndPurge(name, opts.purge === true);
      }
    });
}

export function createHarnessInstallCommand(name: HarnessName): Command {
  return new Command("install")
    .description(
      `install Memory Engine's dormant ${getHarness(name).displayName} integration`,
    )
    .action(() => installHarness(name));
}

export function createHarnessUninstallCommand(name: HarnessName): Command {
  return new Command("uninstall")
    .description(
      `uninstall the recorded ${getHarness(name).displayName} integration`,
    )
    .option("--purge", "remove the harness from local activation profiles")
    .action((opts: { purge?: boolean }) =>
      uninstallHarnessAndPurge(name, opts.purge === true),
    );
}
