/**
 * me space — manage the spaces you belong to and the active space.
 *
 * - me space list:                 list your spaces (marks the active one)
 * - me space use <space>:          set the active space (the X-Me-Space)
 * - me space create <name>:        create a space and make it active
 * - me space rename <space> <name>: rename a space's display label
 * - me space delete <space>:       delete a space and all its data
 * - me space invite <email> [--admin]: add an existing user to the active space
 *
 * <space> accepts a slug (exact) or a name (case-insensitive). The slug is the
 * immutable 12-char routing key; the name is the renamable display label.
 */
import * as clack from "@clack/prompts";
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import { Command } from "commander";
import { createUserClient } from "../client.ts";
import {
  clearActiveSpace,
  resolveCredentials,
  setActiveSpace,
} from "../credentials.ts";
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
} from "../util.ts";

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
      requireSession(creds, fmt);

      const user = createUserClient({
        url: creds.server,
        token: creds.sessionToken,
      });

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
        handleError(error, fmt, { sessionServer: creds.server });
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
      requireSession(creds, fmt);

      const user = createUserClient({
        url: creds.server,
        token: creds.sessionToken,
      });

      try {
        const { spaces } = await user.space.list();
        const space = await resolveSpaceArg(spaces, arg, fmt);
        setActiveSpace(creds.server, space.slug);
        output({ space, switched: true }, fmt, () => {
          clack.log.success(`Active space: ${space.name} (${space.slug})`);
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
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
      requireSession(creds, fmt);

      const user = createUserClient({
        url: creds.server,
        token: creds.sessionToken,
      });

      try {
        const created = await user.space.create({ name });
        // A new space's creator is its admin + owner@root — make it active.
        setActiveSpace(creds.server, created.slug);
        output({ ...created, name, active: true }, fmt, () => {
          clack.log.success(`Created space '${name}' (${created.slug})`);
          clack.log.info("It is now your active space.");
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
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
      requireSession(creds, fmt);

      const user = createUserClient({
        url: creds.server,
        token: creds.sessionToken,
      });

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
        handleError(error, fmt, { sessionServer: creds.server });
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
      requireSession(creds, fmt);

      const user = createUserClient({
        url: creds.server,
        token: creds.sessionToken,
      });

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
        // If we just deleted the active space, drop the stale pointer.
        if (result.deleted && creds.activeSpace === space.slug) {
          clearActiveSpace(creds.server);
        }
        output({ slug: space.slug, ...result }, fmt, () => {
          if (result.deleted) {
            clack.log.success(`Space '${space.name}' has been deleted.`);
            if (creds.activeSpace === space.slug) {
              clack.log.info("Run 'me space use <space>' to pick another.");
            }
          }
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
}

function createSpaceInviteCommand(): Command {
  return new Command("invite")
    .description("add an existing user to the active space (by email)")
    .argument("<email>", "the user's email")
    .option("--admin", "grant space-admin (manage members and groups)")
    .action(async (email: string, opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const creds = resolveCredentials(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      requireSession(creds, fmt);
      requireSpace(creds, fmt);

      const memory = buildMemoryClient(creds);

      try {
        const { principal } = await memory.principal.resolveByEmail({ email });
        if (!principal) {
          const msg = `No user found with email '${email}'. They must sign in once before they can be added.`;
          if (fmt === "text") {
            clack.log.error(msg);
          } else {
            output({ error: msg }, fmt, () => {});
          }
          process.exit(1);
        }

        const result = await memory.principal.add({
          principalId: principal.id,
          admin: opts.admin === true,
        });
        output({ email, principalId: principal.id, ...result }, fmt, () => {
          clack.log.success(
            `Added ${email} to the space${opts.admin ? " as an admin" : ""}.`,
          );
        });
      } catch (error) {
        handleError(error, fmt, { sessionServer: creds.server });
      }
    });
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
