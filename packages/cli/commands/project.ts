/**
 * me project — harness-agnostic per-project setup.
 *
 * `me project init` is the interactive wizard that configures a project's
 * `.me/config.yaml` (see CLAUDE_INIT_WIZARD.md for the target UX). It replaces
 * the plugin-scope decision with committed config: one user-scoped plugin
 * (`me claude install`, run once) reads this file per project, so a teammate
 * who clones the repo gets the project's behavior with no per-repo install.
 *
 * The wizard:
 *   - preflight — offers `me login` when logged out (a session is required —
 *     declining stops), and the Claude plugin install when missing (declining
 *     continues with a warning);
 *   - 0. space — pick (or create) the space this project's memories live in;
 *     server + space are pinned together (a committed config must be
 *     self-contained);
 *   - 1. location — the project tree root: public `/share/projects/<slug>`
 *     (default), private `~/projects/<slug>`, or custom;
 *   - 2. agent — ALWAYS configures a dedicated agent (new whole-space, new
 *     this-project-only, or an existing one; there is no run-as-your-own-user
 *     option) and grants a new agent write access at the chosen scope;
 *   - write — `.me/config.yaml` (server/space/tree/agent) plus Claude's
 *     `.claude/settings.json` `env.ME_AS_AGENT=<agent name>` (the literal
 *     name, not the `.me` sentinel — Claude's Bash tool runs from arbitrary
 *     cwds where a `.me` walk-up wouldn't resolve).
 */
import * as clack from "@clack/prompts";
import { accessLevelName } from "@memory.build/protocol/space";
import { Command } from "commander";
import { writeClaudeSettingsEnv } from "../claude/settings.ts";
import {
  type ResolvedCredentials,
  resolveCredentials,
  setActiveSpace,
} from "../credentials.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat, output } from "../output.ts";
import { writeProjectConfig } from "../project-config.ts";
import { buildMemoryClient, buildUserClient, handleError } from "../util.ts";
import { pluginInstallAvailable, runClaudeInstallFlow } from "./claude.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";

/**
 * Sentinel option values for the selects. `create-space` cannot collide with
 * a real space slug (slugs are 12-char alphanumeric — no dash); `custom-tree`
 * only competes with the two fixed tree options, never user input.
 */
const CREATE_SPACE = "create-space";
const CUSTOM_TREE = "custom-tree";

/** Agent-name shape (mirrors the protocol's principalHandleNameSchema). */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Exit via clack's cancel outro. */
function bail(): never {
  clack.cancel("Cancelled.");
  process.exit(0);
}

/** Unwrap a clack prompt result, exiting cleanly on cancel. */
function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) bail();
  return value as T;
}

/**
 * Spawn `me login` as a child with inherited stdio (the login flow is its own
 * interactive browser round-trip). Resolves how this process is running the
 * same way the git hook does: the compiled `me` binary, else a source run
 * (`bun …/index.ts`). Returns whether login succeeded.
 */
async function runLoginSubprocess(server?: string): Promise<boolean> {
  const argv: string[] = [process.execPath];
  const entry = process.argv[1];
  if (entry && /\.(ts|js)$/.test(entry)) argv.push(entry);
  argv.push("login");
  if (server) argv.push("--server", server);
  const proc = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}

/**
 * Preflight: a login session (required — the wizard lists spaces and creates
 * agents) and the Claude plugin (recommended — capture/tools need it, but the
 * config can be written without). Returns refreshed credentials.
 */
async function preflight(
  globalOpts: Record<string, unknown>,
): Promise<ResolvedCredentials> {
  const serverFlag =
    typeof globalOpts.server === "string" ? globalOpts.server : undefined;
  let creds = resolveCredentials(serverFlag);

  if (!creds.loggedIn) {
    const login = unwrap(
      await clack.confirm({
        message: "You're not logged in to Memory Engine — log in now?",
      }),
    );
    if (!login) {
      clack.log.error(
        "me project init needs a login session (to list spaces and create agents). Run 'me login' and try again.",
      );
      process.exit(1);
    }
    if (!(await runLoginSubprocess(serverFlag))) {
      clack.log.error("Login failed — try again with 'me login'.");
      process.exit(1);
    }
    creds = resolveCredentials(serverFlag);
    if (!creds.loggedIn) {
      clack.log.error("Still not logged in. Run 'me login' and try again.");
      process.exit(1);
    }
  }

  // Plugin: offer the full install flow (it pins global defaults and asks
  // about capture itself). Declining continues — the config can be written
  // now and the plugin installed later.
  if ((await pluginInstallAvailable()) === "available") {
    const install = unwrap(
      await clack.confirm({
        message:
          "The Memory Engine plugin isn't installed for Claude Code — install it now?",
      }),
    );
    if (install) {
      await runClaudeInstallFlow({ server: serverFlag }, globalOpts);
      creds = resolveCredentials(serverFlag);
    } else {
      clack.log.warn(
        "Continuing without the plugin — session capture and the memory tools won't work until you run 'me claude install'.",
      );
    }
  }

  return creds;
}

/** Step 0 — pick (or create) the space this project's memories live in. */
async function pickSpace(
  creds: ResolvedCredentials,
): Promise<{ slug: string; name: string }> {
  const user = buildUserClient(creds);
  const { spaces } = await user.space.list();

  const options: clack.Option<string>[] = spaces.map((s) => ({
    value: s.slug,
    label: s.name,
    hint:
      s.slug === creds.activeSpace ? `${s.slug} — your active space` : s.slug,
  }));
  options.push({
    value: CREATE_SPACE,
    label: "＋ Create a new space…",
    hint: "you become its admin/owner",
  });

  const picked = unwrap(
    await clack.select({
      message: "Which space should this project use?",
      options,
      initialValue:
        creds.activeSpace && spaces.some((s) => s.slug === creds.activeSpace)
          ? creds.activeSpace
          : options[0]?.value,
    }),
  );

  if (picked !== CREATE_SPACE) {
    const space = spaces.find((s) => s.slug === picked);
    if (!space) throw new Error(`space '${picked}' disappeared`);
    return { slug: space.slug, name: space.name };
  }

  const name = unwrap(
    await clack.text({
      message: "Name for the new space:",
      validate: (v) =>
        !v || v.trim().length === 0 ? "a name is required" : undefined,
    }),
  ).trim();
  const created = await user.space.create({ name });
  // Mirror `me space create`: the new space becomes the active one.
  setActiveSpace(creds.server, created.slug);
  clack.log.success(`Created space '${name}' (${created.slug})`);
  return { slug: created.slug, name };
}

/** Step 1 — where this project's memories live (the tree root). */
async function pickTree(slug: string): Promise<string> {
  const publicTree = `/share/projects/${slug}`;
  const privateTree = `~/projects/${slug}`;
  const picked = unwrap(
    await clack.select({
      message: "Where should this project's memories live?",
      options: [
        {
          value: publicTree,
          label: publicTree,
          hint: "Public (default) — shared with the whole team",
        },
        {
          value: privateTree,
          label: privateTree,
          hint: "Private — only you can see them",
        },
        { value: CUSTOM_TREE, label: "(custom)", hint: "type any tree root" },
      ],
      initialValue: publicTree,
    }),
  );
  if (picked !== CUSTOM_TREE) return picked;

  return unwrap(
    await clack.text({
      message: "Custom tree root:",
      placeholder: publicTree,
      validate: (v) =>
        !v || !VALID_TREE_ROOT_RE.test(v)
          ? "use ltree labels ([A-Za-z0-9_-]) separated by '/' or '.', optional leading '~'"
          : undefined,
    }),
  );
}

/** One of the caller's agents, with its membership in the chosen space. */
interface OwnedAgent {
  id: string;
  name: string;
  inSpace: boolean;
}

/** The step-2 outcome: the agent's name (+ id when it already exists). */
interface AgentChoice {
  name: string;
  /** "space" = whole-space grant, "project" = this project's tree, "existing" = grant nothing. */
  scope: "space" | "project" | "existing";
}

/**
 * Step 2 — how this project's agent is set up. The wizard always configures
 * one (no run-as-your-own-user option); the `agent` field itself stays
 * optional in the schema.
 */
async function pickAgent(
  agents: OwnedAgent[],
  slug: string,
): Promise<AgentChoice> {
  const existing = agents.filter((a) => a.inSpace);
  const options: clack.Option<string>[] = [
    {
      value: "space",
      label: "Create a new agent with access to the whole space",
      hint: "default",
    },
    {
      value: "project",
      label: "Create a new agent with access to only this project",
    },
  ];
  if (existing.length > 0) {
    options.push({ value: "existing", label: "Use an existing agent" });
  }
  const scope = unwrap(
    await clack.select({
      message: "How should an agent for this project be set up?",
      options,
      initialValue: "space",
    }),
  ) as AgentChoice["scope"];

  if (scope === "existing") {
    return { name: await pickExistingAgent(existing), scope };
  }

  // 2a — name the new agent: prefill `<slug>-agent`, bumped to a free variant
  // so confirming always creates rather than colliding.
  const taken = new Set(agents.map((a) => a.name.toLowerCase()));
  const name = unwrap(
    await clack.text({
      message: "Name for the new agent:",
      initialValue: freeAgentName(slug, taken),
      validate: (v) => {
        if (!v || !AGENT_NAME_RE.test(v)) {
          return "must start alphanumeric and contain only letters, numbers, '.', '_', or '-'";
        }
        if (taken.has(v.toLowerCase())) {
          return `you already have an agent named '${v}'`;
        }
        return undefined;
      },
    }),
  );
  return { name, scope };
}

/**
 * The 2a prefill: `<slug>-agent`, bumped to the next free `-<n>` variant
 * against the caller's existing agent names (case-insensitive) so confirming
 * always creates a new agent rather than colliding.
 */
export function freeAgentName(slug: string, taken: Set<string>): string {
  const base = `${slug}-agent`;
  let candidate = base;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

/** The client slices {@link provisionNewAgent} needs (injectable for tests). */
export interface AgentProvisioningClients {
  user: { agent: { create(p: { name: string }): Promise<{ id: string }> } };
  memory: {
    principal: { add(p: { principalId: string }): Promise<unknown> };
    grant: {
      set(p: {
        principalId: string;
        treePath: string;
        access: 1 | 2 | 3;
      }): Promise<unknown>;
    };
  };
}

/**
 * Provision a new project agent: create it, add it to the space (the memory
 * client is pinned to the chosen space), and grant WRITE (2) at `treePath` —
 * `""` for the whole space, else the project tree. Write, not owner: a coding
 * agent reads/writes memories but shouldn't manage access; the server clamps
 * an agent to least(agent, owner) per path, so a root grant gives it exactly
 * what the caller can reach. Returns the new agent's id.
 */
export async function provisionNewAgent(
  clients: AgentProvisioningClients,
  name: string,
  treePath: string,
): Promise<string> {
  const { id } = await clients.user.agent.create({ name });
  await clients.memory.principal.add({ principalId: id });
  await clients.memory.grant.set({ principalId: id, treePath, access: 2 });
  return id;
}

/** Step 2b — pick one of the caller's agents already in the space. */
async function pickExistingAgent(existing: OwnedAgent[]): Promise<string> {
  const picked = unwrap(
    await clack.select({
      message: "Which agent should this project use?",
      options: existing.map((a) => ({
        value: a.name,
        label: a.name,
        hint: a.id,
      })),
    }),
  );
  return picked;
}

/**
 * The interactive wizard behind `me project init` — preflight, the space /
 * location / agent prompts, provisioning, and the config + settings writes.
 * Returns the context later phases (the setup checklist) need.
 */
export async function runProjectInitWizard(
  globalOpts: Record<string, unknown>,
): Promise<{
  creds: ResolvedCredentials;
  projectRoot: string;
  space: { slug: string; name: string };
  tree: string;
  agent: string;
}> {
  const creds = await preflight(globalOpts);

  // 0. Space (server + space pin together — a space lives on one server).
  const space = await pickSpace(creds);

  // 1. Location — slug derived once from the project (git origin repo name →
  // git root dir name → basename(cwd)); the git root is the project root the
  // config lands in.
  const { slug, gitRoot } = await new SlugRegistry().resolve(process.cwd());
  const projectRoot = gitRoot ?? process.cwd();
  const tree = await pickTree(slug);

  // 2. Agent. Membership is checked per owned agent so "use an existing
  // agent" only offers ones already usable in the chosen space.
  const user = buildUserClient(creds);
  const { agents } = await user.agent.list();
  const owned: OwnedAgent[] = await Promise.all(
    agents.map(async (a) => {
      const { spaces } = await user.agent.spaces({ id: a.id });
      return {
        id: a.id,
        name: a.name,
        inSpace: spaces.some((s) => s.slug === space.slug),
      };
    }),
  );
  const choice = await pickAgent(owned, slug);

  // Provision a new agent (see provisionNewAgent). An existing agent's
  // grants apply unchanged — the wizard grants nothing.
  const memory = buildMemoryClient({ ...creds, activeSpace: space.slug });
  if (choice.scope !== "existing") {
    const spin = clack.spinner();
    spin.start(`Creating agent '${choice.name}'...`);
    const treePath = choice.scope === "space" ? "" : tree;
    await provisionNewAgent({ user, memory }, choice.name, treePath);
    spin.stop(
      `Created agent '${choice.name}' — ${accessLevelName(2)} on ${
        choice.scope === "space" ? "the whole space" : tree
      }`,
    );
  }

  // Write the committed project config + Claude's settings.json env. The
  // writers invalidate the process-wide `.me` memo, so later phases resolve
  // the fresh pin.
  const configPath = writeProjectConfig(projectRoot, {
    server: creds.server,
    space: space.slug,
    tree,
    agent: choice.name,
  });
  clack.log.success(`Wrote ${configPath}`);
  const settingsPath = writeClaudeSettingsEnv(projectRoot, {
    ME_AS_AGENT: choice.name,
  });
  clack.log.success(`Pinned ME_AS_AGENT=${choice.name} in ${settingsPath}`);

  return { creds, projectRoot, space, tree, agent: choice.name };
}

/** `me project init` — the interactive project-setup wizard. */
function createProjectInitCommand(): Command {
  return new Command("init")
    .description(
      "configure this project's .me/config.yaml (space, memory location, agent) — interactive",
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const fmt = getOutputFormat(globalOpts);
      const interactive =
        fmt === "text" &&
        Boolean(process.stdin.isTTY) &&
        Boolean(process.stdout.isTTY);
      if (!interactive) {
        const msg =
          "me project init is an interactive wizard — run it in a terminal.";
        if (fmt === "text") clack.log.error(msg);
        else output({ error: msg }, fmt, () => {});
        process.exit(1);
      }

      clack.intro("me project init");
      try {
        const result = await runProjectInitWizard(globalOpts);
        clack.outro(
          `Project configured — space '${result.space.name}', memories at ${result.tree}, agent '${result.agent}'.`,
        );
      } catch (error) {
        handleError(error, fmt, {
          creds: resolveCredentials(
            typeof globalOpts.server === "string"
              ? globalOpts.server
              : undefined,
          ),
          scope: "space",
        });
      }
    });
}

/** `me project` — the harness-agnostic project command group. */
export function createProjectCommand(): Command {
  const project = new Command("project").description(
    "per-project Memory Engine setup",
  );
  project.addCommand(createProjectInitCommand());
  return project;
}
