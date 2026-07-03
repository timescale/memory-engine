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
import {
  DIM,
  DIM_OFF,
  type InitStep,
  type InitStepContext,
  initOutroLead,
  runInitSteps,
} from "../agent/init.ts";
import {
  type MemoryPointerSpec,
  memoryPointerUpToDate,
  writeMemoryPointer,
} from "../agent/memory-pointer.ts";
import { writeClaudeSettingsEnv } from "../claude/settings.ts";
import {
  type ResolvedCredentials,
  resolveCredentials,
  setActiveSpace,
} from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat } from "../output.ts";
import {
  discoverProjectConfig,
  writeProjectConfig,
} from "../project-config.ts";
import { buildMemoryClient, buildUserClient, handleError } from "../util.ts";
import { pluginInstallAvailable, runClaudeInstallFlow } from "./claude.ts";
import { runAgentImport, VALID_TREE_ROOT_RE } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";

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

/** The managed CLAUDE.md memory-pointer block the checklist upserts. */
const CLAUDE_MD_POINTER: MemoryPointerSpec = {
  filename: "CLAUDE.md",
  managedBy: "me project init",
  agentLabel: "Claude Code",
};

/**
 * The setup checklist (phase 3 of the wizard; the whole command when run
 * non-interactively). Moved from the retired `me claude init` — minus its
 * plugin-install step (now the wizard's preflight) and plus the
 * capture-enable step, which writes the project's committed `capture` flag.
 *
 * > Harness-agnostic TODO: the session-backfill and CLAUDE.md rows are still
 * > Claude-specific; a fuller `me project init` should gate them on the
 * > harness in scope. Left for a follow-up (see CLAUDE_INTEGRATION_DESIGN.md).
 */
const PROJECT_INIT_STEPS: InitStep[] = [
  {
    id: "transcript-import",
    group: "Claude Code sessions",
    kind: "backfill",
    optionKey: "skipTranscriptImport",
    skipFlag: "--skip-transcript-import",
    skipDescription: "do not import this project's Claude Code sessions",
    label:
      "Import this project's existing Claude Code sessions (one-time backfill)",
    // Init is per-project setup, so scope the backfill to sessions recorded
    // in this repo (cwd at or under the repo root) — `me import claude`
    // remains the machine-wide sweep. A `--project`-scoped run reads the
    // just-written `.me` tree, so the backfill lands exactly where live
    // capture writes — that's why config is written before the checklist.
    // The temp-cwd filter exists to keep throwaway sessions out of bulk
    // sweeps; with the scope pinned to the project the user is standing in,
    // it would only veto projects that happen to live under a temp dir, so
    // include them.
    run: async ({ globalOpts, projectRoot }) => {
      await runAgentImport(
        claudeImporter,
        { project: projectRoot ?? process.cwd(), includeTempCwd: true },
        globalOpts,
      );
    },
  },
  {
    id: "capture-enable",
    group: "Claude Code sessions",
    kind: "ongoing",
    optionKey: "skipCaptureEnable",
    skipFlag: "--skip-capture-enable",
    skipDescription:
      "do not enable ongoing session capture for this project (capture: true)",
    label:
      "Enable ongoing capture of new Claude Code sessions for this project",
    // ✓ when the project already pins capture: true. The capturing itself is
    // done by the installed plugin's hooks; this writes the committed flag
    // that turns them on for this project regardless of the member's global
    // setting.
    available: async ({ projectRoot }) =>
      discoverProjectConfig(projectRoot ?? process.cwd())?.capture === true
        ? "done"
        : "available",
    doneLabel: "Ongoing session capture already enabled for this project",
    rerunLabel:
      "Re-enable ongoing capture of new Claude Code sessions (already enabled)",
    run: async ({ projectRoot }) => {
      const path = writeProjectConfig(projectRoot ?? process.cwd(), {
        capture: true,
      });
      clack.log.success(`Enabled session capture (capture: true) in ${path}`);
    },
  },
  {
    id: "git-import",
    group: "Git history",
    kind: "backfill",
    optionKey: "skipGitImport",
    skipFlag: "--skip-git-import",
    skipDescription: "do not import the repo's git commit history",
    label: "Import existing git commit history (one-time backfill)",
    run: ({ globalOpts }) => runGitImport({ skipIfNotRepo: true }, globalOpts),
  },
  {
    id: "git-hook",
    group: "Git history",
    kind: "ongoing",
    optionKey: "skipGitHook",
    skipFlag: "--skip-git-hook",
    skipDescription: "do not install the git post-commit capture hook",
    label:
      "Install a git post-commit hook — captures new commits going forward",
    // Hidden outside a git repo or when a committed hooks manager owns the
    // hook path; ✓ when the managed block is already installed.
    available: async () => {
      const status = await gitHookStatus(process.cwd());
      if (status === "installed") return "done";
      return status === "installable" ? "available" : "hidden";
    },
    doneLabel: "Git post-commit hook already installed",
    rerunLabel:
      "Reinstall the git post-commit hook — captures new commits going forward (already installed)",
    run: ({ globalOpts }) =>
      runGitHookInstall({ skipIfNotRepo: true }, globalOpts),
  },
  {
    id: "claude-md",
    group: "Project config",
    kind: "config",
    optionKey: "skipClaudeMd",
    skipFlag: "--skip-claude-md",
    skipDescription:
      "do not write the memory pointer into the project's CLAUDE.md",
    label: "Add a memory pointer to CLAUDE.md",
    // ✓ when CLAUDE.md already carries the exact block this run would write;
    // a stale block (template or tree/space change) keeps the step offered
    // so the re-run refreshes it.
    available: async ({ server }) =>
      (await memoryPointerUpToDate(CLAUDE_MD_POINTER, server))
        ? "done"
        : "available",
    doneLabel: "Memory pointer already in CLAUDE.md",
    rerunLabel: "Rewrite the memory pointer in CLAUDE.md (already present)",
    run: ({ server }) => writeMemoryPointer(CLAUDE_MD_POINTER, server),
  },
];

/**
 * Closing guidance after init: a recap of what setup covered (historical
 * backfill, ongoing capture), what having project memories wired up actually
 * buys the user, and how to invoke them deliberately. `steps` is everything
 * covered — the steps that just ran plus any reported already done.
 */
function printInitOutro(steps: InitStep[]): void {
  clack.note(
    [
      ...initOutroLead(steps),
      "Ask Claude about this project's history or architecture — it now",
      "draws on the project's memories automatically, and consults them",
      "when exploring the code for new features.",
      "",
      "You can also point Claude at them explicitly, e.g.:",
      `${DIM}"Search memory engine: why did we structure the database this way?"${DIM_OFF}`,
      `${DIM}"Check me memories for past work on this area before we start"${DIM_OFF}`,
      `${DIM}"What do my me memories say about how deploys work here?"${DIM_OFF}`,
    ].join("\n"),
    "Your project now has memory",
  );
}

/**
 * `me project init` — interactively, the full wizard (preflight → prompts →
 * provisioning → config/settings writes) followed by the setup checklist;
 * non-interactively, just the checklist (every step minus its `--skip-*`
 * flag), matching the retired `me claude init`'s scripted behavior — an
 * existing `.me/config.yaml` (or the private defaults) governs where things
 * land.
 *
 * Pass `deprecatedAlias` to register the same command under a legacy name
 * (`me claude init`) that warns before running.
 */
export function createProjectInitCommand(opts?: {
  deprecatedAlias?: string;
}): Command {
  const cmd = new Command("init").description(
    opts?.deprecatedAlias
      ? `deprecated alias of 'me project init'`
      : "set up this project: space, memory location, agent (interactive wizard) + backfill/capture steps",
  );
  for (const step of PROJECT_INIT_STEPS) {
    cmd.option(step.skipFlag, step.skipDescription);
  }
  cmd.action(async (cmdOpts: Record<string, unknown>, cmdRef: Command) => {
    const globalOpts = cmdRef.optsWithGlobals();
    const fmt = getOutputFormat(globalOpts);
    const server =
      typeof globalOpts.server === "string" ? globalOpts.server : undefined;
    const interactive =
      fmt === "text" &&
      Boolean(process.stdin.isTTY) &&
      Boolean(process.stdout.isTTY);

    if (opts?.deprecatedAlias) {
      clack.log.warn(
        `'${opts.deprecatedAlias}' is now 'me project init' — this alias will be removed in a future release.`,
      );
    }

    try {
      let ctx: InitStepContext;
      if (interactive) {
        clack.intro("me project init");
        const wiz = await runProjectInitWizard(globalOpts);
        ctx = { globalOpts, server, projectRoot: wiz.projectRoot };
      } else {
        // Non-interactive: run the checklist only — no prompts, no config
        // write. An existing `.me/config.yaml` (or the private defaults)
        // governs where the steps land.
        const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
        ctx = { globalOpts, server, projectRoot: gitRoot ?? process.cwd() };
      }

      const result = await runInitSteps(PROJECT_INIT_STEPS, ctx, {
        interactive,
        fmt,
        cmdOpts,
      });

      // Interactively DESELECTING the capture row is an explicit opt-out:
      // write `capture: false` so the committed config is deterministic for
      // the team (absent would fall back to each member's global setting).
      // Leave it alone when the step is already done (capture already true)
      // or when running non-interactively (a --skip is "don't touch", not
      // "turn off").
      const captureTouched =
        result.ran.some((s) => s.id === "capture-enable") ||
        result.done.some((s) => s.id === "capture-enable");
      if (
        interactive &&
        result.offered.includes("capture-enable") &&
        !captureTouched &&
        ctx.projectRoot
      ) {
        const path = writeProjectConfig(ctx.projectRoot, { capture: false });
        clack.log.info(
          `Ongoing session capture disabled for this project (capture: false) in ${path}`,
        );
      }

      if (fmt === "text" && result.ran.length > 0) {
        printInitOutro([...result.ran, ...result.done]);
      }
      if (interactive) clack.outro("Done!");
    } catch (error) {
      handleError(error, fmt, {
        creds: resolveCredentials(server),
        scope: "space",
      });
    }
  });
  return cmd;
}

/** `me project` — the harness-agnostic project command group. */
export function createProjectCommand(): Command {
  const project = new Command("project").description(
    "per-project Memory Engine setup",
  );
  project.addCommand(createProjectInitCommand());
  return project;
}
