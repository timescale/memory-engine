/**
 * me access — tree-access grants in the active space.
 *
 * The core model uses three additive levels: r = read, w = write, o = owner.
 * Grants are keyed by (principal, tree path); an owner grant at a path lets the
 * holder manage access within that subtree.
 *
 * - me access grant <principal> <path> <r|w|o>: grant or update access
 * - me access rm-grant <principal> <path>:      remove a grant
 * - me access list [principal] [--path <p>]:     list grants (optionally scoped)
 * - me access mine:                              list your own grants (any member)
 *
 * <principal> is a UUID, or a name (user = email, agent/group = display name).
 */
import * as clack from "@clack/prompts";
import {
  accessLevelName,
  parseAccessLevel,
} from "@memory.build/protocol/space";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  buildMemoryClient,
  buildUserClient,
  handleError,
  requireAuth,
  requireSpace,
  resolveSpacePrincipalId,
} from "../util.ts";

function createAccessGrantCommand(): Command {
  return new Command("grant")
    .description("grant or update a principal's access at a tree path")
    .argument(
      "<principal>",
      "principal id or name (user email / agent / group)",
    )
    .argument("<path>", "tree path (empty string for the space root)")
    .argument("<level>", "access level: r (read), w (write), o (owner)")
    .action(
      async (principal: string, path: string, level: string, _opts, cmd) => {
        const globalOpts = cmd.optsWithGlobals();
        const creds = resolveCredentials(globalOpts.server);
        const fmt = getOutputFormat(globalOpts);
        requireAuth(creds, fmt);
        requireSpace(creds, fmt);

        const access = parseAccessLevel(level);
        if (!access) {
          handleError(
            new Error(`Invalid level '${level}'. Use r, w, or o.`),
            fmt,
          );
        }

        const memory = buildMemoryClient(creds);
        try {
          const principalId = await resolveSpacePrincipalId(
            memory,
            principal,
            fmt,
          );
          const result = await memory.grant.set({
            principalId,
            treePath: path,
            access,
          });
          output(
            { principalId, treePath: path, access, ...result },
            fmt,
            () => {
              clack.log.success(
                `Granted ${accessLevelName(access)} on '${path}' to ${principal}`,
              );
            },
          );
        } catch (error) {
          handleError(error, fmt, { creds, scope: "space" });
        }
      },
    );
}

function createAccessRmGrantCommand(): Command {
  return new Command("rm-grant")
    .description("remove a principal's grant at a tree path")
    .argument("<principal>", "principal id or name")
    .argument("<path>", "tree path")
    .action(async (principal: string, path: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const principalId = await resolveSpacePrincipalId(
          memory,
          principal,
          fmt,
        );
        const result = await memory.grant.remove({
          principalId,
          treePath: path,
        });
        output({ principalId, treePath: path, ...result }, fmt, () => {
          if (result.removed) {
            clack.log.success(`Removed grant on '${path}' from ${principal}`);
          } else {
            clack.log.warn("Grant not found.");
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

function createAccessListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list grants in the active space")
    .argument("[principal]", "filter by principal id or name")
    .option("--path <path>", "only grants at or below this tree path")
    .action(async (principal: string | undefined, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const principalId = principal
          ? await resolveSpacePrincipalId(memory, principal, fmt)
          : undefined;
        const { grants } = await memory.grant.list({
          principalId: principalId ?? null,
          treePath: opts.path ?? null,
        });

        // Map principal ids → names for display (member-accessible lookup).
        const names = new Map<string, string>();
        const ids = [...new Set(grants.map((g) => g.principalId))];
        if (ids.length > 0) {
          const { principals } = await memory.principal.lookup({ ids });
          for (const p of principals) names.set(p.id, p.name);
        }

        output({ grants }, fmt, () => {
          if (grants.length === 0) {
            console.log("  No grants found.");
            return;
          }
          table(
            ["principal", "tree_path", "access"],
            grants.map((g) => [
              names.get(g.principalId) ?? g.principalId,
              g.treePath === "" ? "(root)" : g.treePath,
              accessLevelName(g.access),
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

function createAccessMineCommand(): Command {
  return new Command("mine")
    .description("list your own access grants (in the active space)")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      const memory = buildMemoryClient(creds);
      try {
        const me = await user.whoami();
        const { grants } = await memory.grant.list({
          principalId: me.id,
          treePath: null,
        });
        output({ grants }, fmt, () => {
          if (grants.length === 0) {
            console.log("  You hold no grants in this space.");
            return;
          }
          table(
            ["tree_path", "access"],
            grants.map((g) => [
              g.treePath === "/" || g.treePath === "" ? "(root)" : g.treePath,
              accessLevelName(g.access),
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

export function createAccessCommand(): Command {
  const access = new Command("access").description(
    "manage tree-access grants in the active space",
  );
  access.addCommand(createAccessGrantCommand());
  access.addCommand(createAccessRmGrantCommand());
  access.addCommand(createAccessListCommand());
  access.addCommand(createAccessMineCommand());
  return access;
}
