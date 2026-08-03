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
  // --purge is intentionally deferred until local-config.ts lands. It must call
  // removeHarnessFromProfiles() rather than duplicate local policy mutations.
  return new Command("uninstall")
    .description("uninstall recorded Memory Engine harness integrations")
    .argument("[harness...]", `harnesses (${HARNESS_NAMES.join(", ")})`)
    .action(async (values: string[]) => {
      for (const name of resolveHarnessTargets(values, false)) {
        await uninstallHarness(name);
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
    .action(() => uninstallHarness(name));
}
