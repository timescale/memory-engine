/**
 * me service — manage service accounts in the active space.
 *
 * Service accounts are space-scoped, team-administered operational identities
 * for integrations, bots, and CI/CD jobs. They authenticate with API keys; keys
 * should be handled like production secrets.
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
  resolveActiveSpace,
  resolveServiceAccountId,
  resolveSpacePrincipalId,
} from "../util.ts";

type InitialAdminMember = { memberId: string; admin?: boolean };

function values(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function mergeAdminMembers(
  members: string[],
  groupAdmins: string[],
): InitialAdminMember[] {
  const byId = new Map<string, InitialAdminMember>();
  for (const memberId of members) byId.set(memberId, { memberId });
  for (const memberId of groupAdmins)
    byId.set(memberId, { memberId, admin: true });
  return [...byId.values()];
}

async function lookupPrincipalName(
  ids: string[],
  creds: Parameters<typeof buildMemoryClient>[0],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const memory = buildMemoryClient(creds);
  const { principals } = await memory.principal.lookup({ ids });
  return new Map(principals.map((p) => [p.id, p.name]));
}

function createServiceListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list service accounts in the active space")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const space = await resolveActiveSpace(user, creds.activeSpace, fmt);
        const { serviceAccounts } = await user.serviceAccount.list({
          spaceId: space.id,
        });
        output({ serviceAccounts }, fmt, () => {
          if (serviceAccounts.length === 0) {
            console.log(
              "  No service accounts. Run 'me service create <name>'.",
            );
            return;
          }
          table(
            ["name", "id", "admin-group"],
            serviceAccounts.map((a) => [a.name, a.id, a.adminId]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createServiceCreateCommand(): Command {
  return new Command("create")
    .description("create a service account in the active space")
    .argument("<name>", "service account name")
    .option(
      "--admin <user>",
      "add an initial user to the bound admin group (repeatable; id or email/name in the active space)",
      (v, prev: string[] = []) => [...prev, v],
    )
    .option(
      "--group-admin <user>",
      "add an initial user as an admin of the bound admin group (repeatable)",
      (v, prev: string[] = []) => [...prev, v],
    )
    .action(async (name: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      const memory = buildMemoryClient(creds);
      try {
        const space = await resolveActiveSpace(user, creds.activeSpace, fmt);
        const members = await Promise.all(
          values(opts.admin).map((m) =>
            resolveSpacePrincipalId(memory, m, fmt, "u"),
          ),
        );
        const groupAdmins = await Promise.all(
          values(opts.groupAdmin).map((m) =>
            resolveSpacePrincipalId(memory, m, fmt, "u"),
          ),
        );
        const { serviceAccount } = await user.serviceAccount.create({
          spaceId: space.id,
          name,
          adminMembers: mergeAdminMembers(members, groupAdmins),
        });
        const names = await lookupPrincipalName(
          [serviceAccount.adminId],
          creds,
        );
        const adminGroupName = names.get(serviceAccount.adminId) ?? null;
        output({ serviceAccount, adminGroupName }, fmt, () => {
          clack.log.success(
            `Created service account '${serviceAccount.name}' (${serviceAccount.id})`,
          );
          console.log(
            `  Admin group: ${adminGroupName ?? "(unknown)"} (${serviceAccount.adminId})`,
          );
          clack.log.info(
            `Mint an operational key with 'me apikey create --service ${serviceAccount.name}'. Treat it like a production secret; it will be shown only once.`,
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createServiceRenameCommand(): Command {
  return new Command("rename")
    .description("rename a service account")
    .argument("<service>", "service account id or name")
    .argument("<new-name>", "new name")
    .action(async (service: string, newName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const space = await resolveActiveSpace(user, creds.activeSpace, fmt);
        const id = await resolveServiceAccountId(user, space.id, service, fmt);
        const result = await user.serviceAccount.rename({ id, name: newName });
        output({ id, name: newName, ...result }, fmt, () => {
          clack.log.success(`Renamed service account → '${newName}'`);
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createServiceDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("delete a service account and its bound admin group")
    .argument("<service>", "service account id or name")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (service: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const user = buildUserClient(creds);
      try {
        const space = await resolveActiveSpace(user, creds.activeSpace, fmt);
        const id = await resolveServiceAccountId(user, space.id, service, fmt);

        if (fmt === "text" && !opts.yes) {
          clack.log.warn(
            "This deletes the service account, its API keys, and its bound admin group.",
          );
          const ok = await clack.confirm({
            message: `Delete service account ${service}?`,
          });
          if (clack.isCancel(ok) || !ok) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await user.serviceAccount.delete({ id });
        output({ id, ...result }, fmt, () => {
          if (result.deleted)
            clack.log.success(`Deleted service account ${service}`);
          else clack.log.warn("Service account not found.");
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

export function createServiceCommand(): Command {
  const service = new Command("service").description(
    "manage service accounts in the active space",
  );
  service.addCommand(createServiceListCommand());
  service.addCommand(createServiceCreateCommand());
  service.addCommand(createServiceRenameCommand());
  service.addCommand(createServiceDeleteCommand());
  return service;
}
