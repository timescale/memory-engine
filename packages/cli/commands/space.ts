/**
 * me space — manage the spaces you belong to and the active space.
 *
 * - me space list:                 list your spaces (marks the active one)
 * - me space use <space>:          set the active space (the X-Me-Space)
 * - me space create <name>:        create a space and make it active
 * - me space rename <space> <name>: rename a space's display label
 * - me space delete <space>:       delete a space and all its data
 * - me space invite --email <addr> | --anyone [--admin] [--group <name>]
 *     [--expires <dur>] [--max-uses <n>]: invite a specific email (single-use)
 *     or mint an open shareable link (multi-use); the redeemer joins the given
 *     group (default "team"). Both print a join link. The invitee joins by
 *     accepting (see `me invite`) or by opening the link.
 * - me space invite list:           list active invitations (email + links)
 * - me space invite revoke <id|email>: revoke an invitation
 *
 * <space> accepts a slug (exact) or a name (case-insensitive). The slug is the
 * immutable 12-char routing key; the name is the renamable display label.
 */
import * as clack from "@clack/prompts";
import { DEFAULT_GROUP_NAME } from "@memory.build/protocol";
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import { Command } from "commander";
import {
  clearActiveSpace,
  getDefaultServer,
  getServerConfig,
  normalizeOrigin,
  resolveCredentials,
  setActiveSpace,
} from "../credentials.ts";
import {
  getOutputFormat,
  type OutputFormat,
  output,
  table,
} from "../output.ts";
import { getProjectConfig, writeProjectSpace } from "../project-config.ts";
import {
  buildMemoryClient,
  buildUserClient,
  handleError,
  requireAuth,
  requireSpace,
} from "../util.ts";
import { resolveGroupIds } from "./group.ts";

/**
 * Resolve a <space> argument against the caller's spaces by slug (exact) or
 * name (case-insensitive). With no argument, prompts in text mode. Exits on a
 * miss / ambiguity / non-interactive-without-arg.
 */
async function resolveSpaceArg(
  spaces: MemberSpaceResponse[],
  arg: string | undefined,
  fmt: OutputFormat,
): Promise<MemberSpaceResponse> {
  if (!arg) {
    if (fmt !== "text") {
      output({ error: "A space slug or name is required" }, fmt, () => {});
      process.exit(1);
    }
    if (spaces.length === 0) {
      clack.log.error("You don't belong to any spaces.");
      process.exit(1);
    }
    const selected = await clack.select({
      message: "Select a space",
      options: spaces.map((s) => ({
        value: s.slug,
        label: s.name,
        hint: s.slug,
      })),
    });
    if (clack.isCancel(selected)) {
      clack.cancel("Cancelled.");
      process.exit(0);
    }
    const picked = spaces.find((s) => s.slug === selected);
    if (picked) return picked;
    process.exit(1);
  }

  const bySlug = spaces.find((s) => s.slug === arg);
  if (bySlug) return bySlug;

  const lower = arg.toLowerCase();
  const byName = spaces.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length === 1 && byName[0]) return byName[0];

  if (byName.length === 0) {
    const msg = `No space matching '${arg}'.`;
    if (fmt === "text") {
      clack.log.error(msg);
      for (const s of spaces) console.log(`  ${s.name} (${s.slug})`);
    } else {
      output({ error: msg }, fmt, () => {});
    }
    process.exit(1);
  }

  const msg = `Multiple spaces named '${arg}'. Use the slug instead:`;
  if (fmt === "text") {
    clack.log.error(msg);
    for (const s of byName) console.log(`  ${s.name} — ${s.slug}`);
  } else {
    output({ error: msg, matches: byName }, fmt, () => {});
  }
  process.exit(1);
}

function createSpaceListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list the spaces you belong to")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const { spaces } = await user.space.list();
        output(
          {
            spaces: spaces.map((s) => ({
              ...s,
              active: s.slug === creds.activeSpace,
            })),
          },
          fmt,
          () => {
            if (spaces.length === 0) {
              console.log("  No spaces. Run 'me space create <name>'.");
              return;
            }
            table(
              ["name", "slug", "admin", "active"],
              spaces.map((s) => [
                s.name,
                s.slug,
                s.admin ? "yes" : "",
                s.slug === creds.activeSpace ? "active" : "",
              ]),
            );
          },
        );
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createSpaceUseCommand(): Command {
  return new Command("use")
    .description("set the active space")
    .argument("[space]", "space slug or name")
    .action(async (arg: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const { spaces } = await user.space.list();
        const space = await resolveSpaceArg(spaces, arg, fmt);

        // Effective-scope write (like `git config`): when a `.me` file in
        // scope defines `space`, that pin shadows the global active_space —
        // edit it instead. Otherwise the global config governs; write there.
        let configPath: string | undefined;
        const project = getProjectConfig();
        if (project) {
          // Keep the pin self-consistent: if the effective server differs from
          // what the project resolves on its own (a --server/ME_SERVER
          // override, or a stale `.me` server pin), write `server:` alongside.
          const projectServer = normalizeOrigin(
            project.server ?? getDefaultServer(),
          );
          configPath = writeProjectSpace(project, {
            space: space.slug,
            server: projectServer === creds.server ? undefined : creds.server,
          });
        }
        if (!configPath) setActiveSpace(creds.server, space.slug);

        output(
          { space, switched: true, configPath: configPath ?? null },
          fmt,
          () => {
            clack.log.success(
              `Active space: ${space.name} (${space.slug}) — saved to ${configPath ?? "global config"}`,
            );
            if (process.env.ME_SPACE && process.env.ME_SPACE !== space.slug) {
              clack.log.warn(
                `ME_SPACE=${process.env.ME_SPACE} is set and overrides the saved active space.`,
              );
            }
          },
        );
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createSpaceCreateCommand(): Command {
  return new Command("create")
    .description("create a new space and make it active")
    .argument("<name>", "space display name")
    .action(async (name: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const created = await user.space.create({ name });
        // A new space's creator is its admin + owner@root — make it active.
        setActiveSpace(creds.server, created.slug);
        output({ ...created, name, active: true }, fmt, () => {
          clack.log.success(`Created space '${name}' (${created.slug})`);
          clack.log.info("It is now your active space.");
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createSpaceRenameCommand(): Command {
  return new Command("rename")
    .description("rename a space's display label (the slug is immutable)")
    .argument("<space>", "space slug or name")
    .argument("<new-name>", "new display name")
    .action(async (arg: string, newName: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const { spaces } = await user.space.list();
        const space = await resolveSpaceArg(spaces, arg, fmt);
        const oldName = space.name;
        const result = await user.space.rename({
          slug: space.slug,
          name: newName,
        });
        output({ slug: space.slug, name: newName, ...result }, fmt, () => {
          clack.log.success(
            `Renamed space '${oldName}' → '${newName}' (${space.slug})`,
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createSpaceDeleteCommand(): Command {
  return new Command("delete")
    .alias("rm")
    .description("permanently delete a space and all its data")
    .argument("<space>", "space slug or name")
    .option("--force", "skip confirmation prompt")
    .action(async (arg: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);

      const user = buildUserClient(creds);

      try {
        const { spaces } = await user.space.list();
        const space = await resolveSpaceArg(spaces, arg, fmt);

        if (fmt === "text" && !opts.force) {
          clack.log.warn(
            "This permanently deletes the space and ALL its data (memories, grants, groups).",
          );
          clack.log.warn("This action cannot be undone.");
          const confirmation = await clack.text({
            message: `Type the space name "${space.name}" to confirm deletion`,
            validate: (value) =>
              value !== space.name
                ? `Please type "${space.name}" exactly to confirm`
                : undefined,
          });
          if (clack.isCancel(confirmation)) {
            clack.cancel("Cancelled.");
            process.exit(0);
          }
        }

        const result = await user.space.delete({ slug: space.slug });
        // If the global config's active_space points at the just-deleted
        // space, drop the stale pointer. Check the stored value directly —
        // creds.activeSpace can come from ME_SPACE or a `.me` pin, and
        // clearing on those would wipe a global selection that points at a
        // different, still-valid space.
        if (
          result.deleted &&
          getServerConfig(creds.server).active_space === space.slug
        ) {
          clearActiveSpace(creds.server);
        }
        output({ slug: space.slug, ...result }, fmt, () => {
          if (result.deleted) {
            clack.log.success(`Space '${space.name}' has been deleted.`);
            const project = getProjectConfig();
            if (project?.space === space.slug) {
              clack.log.warn(
                `This project's .me config (${project.dir}/.me) still pins the deleted space — run 'me space use <space>' here to repoint it.`,
              );
            } else if (creds.activeSpace === space.slug) {
              clack.log.info("Run 'me space use <space>' to pick another.");
            }
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds });
      }
    });
}

function createSpaceInviteListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("list active invitations for the active space (email + links)")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        const { invitations } = await memory.invite.list();
        output({ invitations }, fmt, () => {
          if (invitations.length === 0) {
            console.log("  No active invitations.");
            return;
          }
          table(
            [
              "id",
              "kind",
              "email",
              "admin",
              "group",
              "uses",
              "expires",
              "status",
              "link",
            ],
            invitations.map((i) => [
              i.id,
              i.kind,
              i.email ?? "—",
              i.admin ? "yes" : "",
              i.groupNames.join(", ") || "—",
              i.kind === "link"
                ? `${i.uses}${i.maxUses != null ? `/${i.maxUses}` : ""}`
                : "",
              i.expiresAt ?? "",
              i.valid ? "active" : "expired/used",
              i.token ? inviteUrl(creds.server, i.token) : "—",
            ]),
          );
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

function createSpaceInviteRevokeCommand(): Command {
  return new Command("revoke")
    .description(
      "revoke an invitation by id (link or email) or by invitee email",
    )
    .argument("<id-or-email>", "the invitation id, or the invitee's email")
    .action(async (target: string, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);
      try {
        // An "@" means it's an email (delete the pending email invite); anything
        // else is an invitation id (revoke a link or an email invite by id).
        const byEmail = target.includes("@");
        const result = byEmail
          ? await memory.invite.revoke({ email: target })
          : await memory.invite.revokeById({ invitationId: target });
        output({ target, ...result }, fmt, () => {
          if (result.revoked) {
            clack.log.success(`Revoked the invitation (${target}).`);
          } else {
            clack.log.warn(`No active invitation matching ${target}.`);
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
}

/** Parse a duration like "7d" / "24h" / "30m" into an ISO expiry timestamp. */
function parseExpires(raw: string, fmt: OutputFormat): string {
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  if (!m) {
    inviteFail(
      `Invalid --expires '${raw}'. Use <n>d | <n>h | <n>m (e.g. 7d).`,
      fmt,
    );
  }
  const n = Number(m?.[1]);
  const unitMs = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m?.[2] ?? "d"] ?? 0;
  return new Date(Date.now() + n * unitMs).toISOString();
}

/** Build the shareable invite URL from the server base + token. */
function inviteUrl(server: string, token: string): string {
  return `${server.replace(/\/+$/, "")}/invite/${token}`;
}

/** Print an invite-command error per output mode and exit. Never returns. */
function inviteFail(msg: string, fmt: OutputFormat): never {
  if (fmt === "text") {
    clack.log.error(msg);
  } else {
    output({ error: msg }, fmt, () => {});
  }
  process.exit(1);
}

function createSpaceInviteCommand(): Command {
  const invite = new Command("invite")
    .description(
      "invite to the active space: --email <addr> or --anyone [--group <name>]",
    )
    .option(
      "--email <email>",
      "invite a specific email (only they can join; single-use)",
    )
    .option(
      "--anyone",
      "create an open link anyone signed-in can use to join (multi-use)",
    )
    .option("--admin", "grant the joiner space-admin")
    .option(
      "--group <name-or-id>",
      "group the joiner is added to (repeatable; its grants are their access)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option("--expires <duration>", "link expiry, e.g. 7d | 24h | 30m")
    .option("--max-uses <n>", "max redemptions (with --anyone)")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireAuth(creds, fmt);
      requireSpace(creds, fmt);

      const email = typeof opts.email === "string" ? opts.email : null;
      const anyone = opts.anyone === true;
      // Exactly one audience: a specific --email, or --anyone (an open link).
      if (!email && !anyone) {
        inviteFail(
          "Choose an audience: --email <addr> for one person, or --anyone for an open link.",
          fmt,
        );
      }
      if (email && anyone) {
        inviteFail("Use either --email or --anyone, not both.", fmt);
      }

      const expiresAt = opts.expires
        ? parseExpires(opts.expires as string, fmt)
        : null;
      let maxUses: number | null = null;
      if (opts.maxUses !== undefined) {
        const n = Number.parseInt(opts.maxUses as string, 10);
        if (!Number.isInteger(n) || n <= 0) {
          inviteFail("--max-uses must be a positive integer.", fmt);
        }
        maxUses = n;
      }

      const memory = buildMemoryClient(creds);
      // --group is repeatable and defaults to just "team"; resolve each name/id to
      // a group id (errors if the space has no such group). The joiner's access is
      // the union of these groups' grants.
      const groupNames = (opts.group as string[]).length
        ? (opts.group as string[])
        : [DEFAULT_GROUP_NAME];
      const groupsLabel = groupNames.join(", ");
      try {
        const groupIds = await resolveGroupIds(memory, groupNames, fmt);
        const result = await memory.invite.create({
          email,
          admin: opts.admin === true,
          groupIds,
          expiresAt,
          maxUses,
        });
        const url = inviteUrl(creds.server, result.token);
        output({ email, groups: groupNames, link: url, ...result }, fmt, () => {
          if (email) {
            clack.log.success(
              `Invited ${email}${opts.admin ? " as an admin" : ""} to ${groupsLabel} — pending their acceptance.`,
            );
            clack.log.info(`Or share this link: ${url}`);
          } else {
            clack.log.success(
              `Created an open invite link${opts.admin ? " (admin)" : ""} for ${groupsLabel}.`,
            );
            clack.note(url, "Share this link");
          }
        });
      } catch (error) {
        handleError(error, fmt, { creds, scope: "space" });
      }
    });
  invite.addCommand(createSpaceInviteListCommand());
  invite.addCommand(createSpaceInviteRevokeCommand());
  return invite;
}

export function createSpaceCommand(): Command {
  const space = new Command("space").description("manage spaces");
  space.addCommand(createSpaceListCommand());
  space.addCommand(createSpaceUseCommand());
  space.addCommand(createSpaceCreateCommand());
  space.addCommand(createSpaceRenameCommand());
  space.addCommand(createSpaceDeleteCommand());
  space.addCommand(createSpaceInviteCommand());
  return space;
}
