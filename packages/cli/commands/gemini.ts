/** Gemini CLI integration commands. */
import { Command } from "commander";
import { buildGeminiEnvHookOutput } from "../gemini/env-hook.ts";
import { logUnrecognizedPayloadShape } from "../harness-shape-log.ts";
import {
  createHarnessInstallCommand,
  createHarnessUninstallCommand,
} from "./install.ts";

function createGeminiEnvHookCommand(): Command {
  return new Command("env-hook")
    .description("inject the Gemini shell contract")
    .action(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(await Bun.stdin.text());
      } catch {
        logUnrecognizedPayloadShape("gemini", undefined);
        return;
      }
      const result = buildGeminiEnvHookOutput(payload, process.env);
      if (result.unrecognizedShape) {
        logUnrecognizedPayloadShape("gemini", payload);
      }
      if (result.output) console.log(JSON.stringify(result.output));
    });
}

export function createGeminiCommand(): Command {
  const gemini = new Command("gemini").description("Gemini CLI integration");
  gemini.addCommand(createHarnessInstallCommand("gemini"));
  gemini.addCommand(createHarnessUninstallCommand("gemini"));
  gemini.addCommand(createGeminiEnvHookCommand());
  return gemini;
}
