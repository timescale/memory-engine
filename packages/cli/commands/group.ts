/**
 * me group — manage groups in the active space.
 *
 * Groups bundle members (users / agents) so a single tree-access grant covers
 * everyone in the group. Group membership also confers space membership.
 *
 * - me group list:                       list groups
 * - me group create <name>:              create a group
 * - me group rename <group> <new-name>:  rename a group
 * - me group delete <group>:             delete a group
 * - me group add <group> <member> [--admin]: add a member (user/agent)
 * - me group remove <group> <member>:    remove a member
 * - me group members <group>:            list a group's members
 *
 * <group> is a group id or name; <member> is a user/agent id or name (a UUID is
 * always accepted; name resolution requires space-manager authority).
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import type { MemoryClient } from "../client.ts";
import { resolveCredentials } from "../credentials.ts";
import {
  getOutputFormat,
  type OutputFormat,
  output,
  table,
} from "../output.ts";
import {
  buildMemoryClient,
  handleError,
  requireSession,
  requireSpace,
  resolveSpacePrincipalId,
} from "../util.ts";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve a group id from a UUID or name (via group.list). */
async function resolveGroupId(
  memory: MemoryClient,
  input: string,
  fmt: OutputFormat,
): Promise<string> {
  if (UUIDV7_RE.test(input)) return input;
  const { groups } = await memory.group.list();
  const lower = input.toLowerCase();
  const matches = groups.filter((g) => g.name.toLowerCase() === lower);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  const msg =
    matches.length === 0
      ? `No group named '${input}' in this space.`
      : `Multiple groups named '${input}'. Use the group id instead.`;
  if (fmt === "text") {
    clack.log.error(msg);
    if (matches.length > 1)
      for (const g of matches) console.log(`  ${g.name} — ${g.id}`);
  } else {
    output({ error: msg, matches }, fmt, () => {});
  }
  process.exit(1);
}

function createGroupListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list groups in the active space")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const { groups } = await memory.group.list();
        output({ groups }, fmt, () => {
          if (groups.length === 0) {
            console.log("  No groups. Run 'me group create <name>'.");
            return;
          }
          table(
            ["name", "id"],
            groups.map((g) => [g.name, g.id]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupCreateCommand(): Command {
  return new Command("create")
    .description("create a group")
    .argument("<name>", "group name")
    .action(async (name: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const { id } = await memory.group.create({ name });
        output({ id, name }, fmt, () => {
          clack.log.success(`Created group '${name}' (${id})`);
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupRenameCommand(): Command {
  return new Command("rename")
    .description("rename a group")
    .argument("<group>", "group id or name")
    .argument("<new-name>", "new name")
    .action(async (group: string, newName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const id = await resolveGroupId(memory, group, fmt);
        const result = await memory.group.rename({ id, name: newName });
        output({ id, name: newName, ...result }, fmt, () => {
          clack.log.success(`Renamed group → '${newName}'`);
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete a group")
    .argument("<group>", "group id or name")
    .action(async (group: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const id = await resolveGroupId(memory, group, fmt);
        const result = await memory.group.delete({ id });
        output({ id, ...result }, fmt, () => {
          if (result.deleted) clack.log.success(`Deleted group ${group}`);
          else clack.log.warn("Group not found.");
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupAddCommand(): Command {
  return new Command("add")
    .description("add a member (user/agent) to a group")
    .argument("<group>", "group id or name")
    .argument("<member>", "user/agent id or name")
    .option("--admin", "make them a group admin (can manage group membership)")
    .action(async (group: string, member: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const groupId = await resolveGroupId(memory, group, fmt);
        const memberId = await resolveSpacePrincipalId(memory, member, fmt);
        const result = await memory.group.addMember({
          groupId,
          memberId,
          admin: opts.admin === true,
        });
        output({ groupId, memberId, ...result }, fmt, () => {
          clack.log.success(
            `Added ${member} to group ${group}${opts.admin ? " as an admin" : ""}.`,
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupRemoveCommand(): Command {
  return new Command("remove")
    .alias("rm-member")
    .description("remove a member from a group")
    .argument("<group>", "group id or name")
    .argument("<member>", "user/agent id or name")
    .action(async (group: string, member: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const groupId = await resolveGroupId(memory, group, fmt);
        const memberId = await resolveSpacePrincipalId(memory, member, fmt);
        const result = await memory.group.removeMember({ groupId, memberId });
        output({ groupId, memberId, ...result }, fmt, () => {
          if (result.removed)
            clack.log.success(`Removed ${member} from ${group}`);
          else clack.log.warn("Member not in group.");
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createGroupMembersCommand(): Command {
  return new Command("members")
    .description("list a group's members")
    .argument("<group>", "group id or name")
    .action(async (group: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const groupId = await resolveGroupId(memory, group, fmt);
        const { members } = await memory.group.listMembers({ groupId });
        output({ members }, fmt, () => {
          if (members.length === 0) {
            console.log("  No members.");
            return;
          }
          table(
            ["name", "kind", "admin", "id"],
            members.map((m) => [
              m.name,
              m.kind,
              m.admin ? "yes" : "",
              m.memberId,
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

export function createGroupCommand(): Command {
  const group = new Command("group").description(
    "manage groups in the active space",
  );
  group.addCommand(createGroupListCommand());
  group.addCommand(createGroupCreateCommand());
  group.addCommand(createGroupRenameCommand());
  group.addCommand(createGroupDeleteCommand());
  group.addCommand(createGroupAddCommand());
  group.addCommand(createGroupRemoveCommand());
  group.addCommand(createGroupMembersCommand());
  return group;
}
