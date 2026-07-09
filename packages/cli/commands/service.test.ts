/** Unit tests for service-account CLI command surfaces. */
import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { createApiKeyCommand } from "./apikey.ts";
import { createServiceCommand } from "./service.ts";

function subcommand(cmd: Command, name: string): Command {
  const found = cmd.commands.find((c) => c.name() === name);
  if (!found) throw new Error(`missing subcommand ${name}`);
  return found;
}

function optionLongs(cmd: Command): string[] {
  return cmd.options.map((o) => o.long).filter((o): o is string => !!o);
}

function allOptionLongs(cmd: Command): string[] {
  return [
    ...optionLongs(cmd),
    ...cmd.commands.flatMap((child) => allOptionLongs(child)),
  ];
}

describe("service command", () => {
  test("exposes the service-account lifecycle subcommands", () => {
    const service = createServiceCommand();
    expect(service.commands.map((c) => c.name()).sort()).toEqual([
      "create",
      "delete",
      "list",
      "rename",
    ]);
    expect(optionLongs(subcommand(service, "create"))).toEqual([
      "--admin",
      "--group-admin",
    ]);
    expect(optionLongs(subcommand(service, "delete"))).toContain("--yes");
  });

  test("does not introduce an act-as-service option", () => {
    expect(allOptionLongs(createServiceCommand())).not.toContain(
      "--as-service",
    );
    expect(allOptionLongs(createApiKeyCommand())).not.toContain("--as-service");
  });
});

describe("apikey command", () => {
  test("can target service accounts for create and list", () => {
    const apikey = createApiKeyCommand();
    expect(optionLongs(subcommand(apikey, "create"))).toContain("--service");
    expect(optionLongs(subcommand(apikey, "list"))).toContain("--service");
  });
});
