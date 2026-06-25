/**
 * me agent — manage your agents (global service accounts).
 *
 * Agents are owned by you and live across spaces; their lifecycle is on the
 * user endpoint. Bringing an agent into the active space and minting its
 * (space-bound) api key are space operations — see `me agent add` and
 * `me apikey create`.
 *
 * - me agent list:                    list your agents
 * - me agent create <name>:           create an agent
 * - me agent rename <agent> <name>:   rename an agent
 * - me agent delete <agent>:          delete an agent
 * - me agent add <agent>:             add the agent to the active space
 * - me agent spaces <agent>:          list the agent's spaces
 * - me agent groups <agent>:          list the agent's groups in the active space
 *
 * <agent> is an agent id or name (names are unique per user).
 */
import * as clack from "@clack/prompts";
import { Command } from "commander";
import { resolveCredentials } from "../credentials.ts";
import { getOutputFormat, output, table } from "../output.ts";
import {
  buildMemoryClient,
  buildUserClient,
  handleError,
  requireAuth,
  requireSpace,
  resolveAgentId,
} from "../util.ts";

function createAgentListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list your agents")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const { agents } = await user.agent.list();
        output({ agents }, fmt, () => {
          if (agents.length === 0) {
            console.log("  No agents. Run 'me agent create <name>'.");
            return;
          }
          table(
            ["name", "id"],
            agents.map((a) => [a.name, a.id]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createAgentCreateCommand(): Command {
  return new Command("create")
    .description("create an agent")
    .argument("<name>", "agent name (unique per user)")
    .action(async (name: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const { id } = await user.agent.create({ name });
        output({ id, name }, fmt, () => {
          clack.log.success(`Created agent '${name}' (${id})`);
          clack.log.info(
            "Add it to a space with 'me agent add', then mint a key with 'me apikey create'.",
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createAgentRenameCommand(): Command {
  return new Command("rename")
    .description("rename an agent")
    .argument("<agent>", "agent id or name")
    .argument("<new-name>", "new name")
    .action(async (agent: string, newName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const id = await resolveAgentId(user, agent, fmt);
        const result = await user.agent.rename({ id, name: newName });
        output({ id, name: newName, ...result }, fmt, () => {
          clack.log.success(`Renamed agent → '${newName}'`);
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createAgentDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete an agent")
    .argument("<agent>", "agent id or name")
    .action(async (agent: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const id = await resolveAgentId(user, agent, fmt);
        const result = await user.agent.delete({ id });
        output({ id, ...result }, fmt, () => {
          if (result.deleted) clack.log.success(`Deleted agent ${agent}`);
          else clack.log.warn("Agent not found.");
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createAgentAddCommand(): Command {
  return new Command("add")
    .description("add one of your agents to the active space")
    .argument("<agent>", "agent id or name")
    .action(async (agent: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      const memory = buildMemoryClient(creds);
      try {
        const id = await resolveAgentId(user, agent, fmt);
        // Bringing your own agent into a space is self-service (no admin flag).
        const result = await memory.principal.add({ principalId: id });
        output({ agentId: id, ...result }, fmt, () => {
          clack.log.success(`Added agent ${agent} to the space.`);
          clack.log.info("Mint a key with 'me apikey create'.");
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

function createAgentSpacesCommand(): Command {
  return new Command("spaces")
    .description("list the spaces an agent belongs to")
    .argument("<agent>", "agent id or name")
    .action(async (agent: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const id = await resolveAgentId(user, agent, fmt);
        const { spaces } = await user.agent.spaces({ id });
        const withActive = spaces.map((s) => ({
          ...s,
          active: s.slug === creds.activeSpace,
        }));
        output({ agentId: id, spaces: withActive }, fmt, () => {
          if (spaces.length === 0) {
            console.log(
              "  No spaces. Add the agent to a space with 'me agent add <agent>'.",
            );
            return;
          }
          table(
            ["name", "slug", "active"],
            spaces.map((s) => [
              s.name,
              s.slug,
              s.slug === creds.activeSpace ? "active" : "",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createAgentGroupsCommand(): Command {
  return new Command("groups")
    .description("list an agent's groups in the active space")
    .argument("<agent>", "agent id or name")
    .action(async (agent: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      const memory = buildMemoryClient(creds);
      try {
        const id = await resolveAgentId(user, agent, fmt);
        const { groups } = await memory.group.listForMember({ memberId: id });
        output({ groups }, fmt, () => {
          if (groups.length === 0) {
            console.log("  Not in any groups.");
            return;
          }
          table(
            ["group", "admin", "id"],
            groups.map((g) => [g.name, g.admin ? "yes" : "", g.groupId]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

export function createAgentCommand(): Command {
  const agent = new Command("agent").description("manage your agents");
  agent.addCommand(createAgentListCommand());
  agent.addCommand(createAgentCreateCommand());
  agent.addCommand(createAgentRenameCommand());
  agent.addCommand(createAgentDeleteCommand());
  agent.addCommand(createAgentAddCommand());
  agent.addCommand(createAgentSpacesCommand());
  agent.addCommand(createAgentGroupsCommand());
  return agent;
}
