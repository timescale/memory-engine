/**
 * me project — harness-agnostic per-project setup.
 *
 * `me project init` is the interactive wizard that configures a project's
 * `.me/config.yaml`. It replaces the plugin-scope decision with committed
 * config: one user-scoped plugin/install (run once per harness) reads this
 * file per project, so a teammate who clones the repo gets the project's
 * behavior with no per-repo install.
 *
 * The wizard:
 *   - preflight — offers `me login` when logged out (a session is required —
 *     declining stops), and — on a genuinely fresh machine (no harness set
 *     up yet at all) — a multiselect offering to set up every harness
 *     detected as installed but not configured; declining any of them
 *     continues with a warning;
 *   - 0. space — pick (or create) the space this project's memories live in;
 *     server + space are pinned together (a committed config must be
 *     self-contained);
 *   - 1. location — the project tree root: public `/share/projects/<slug>`
 *     (default), private `~/projects/<slug>`, or custom;
 *   - 2. agent — ALWAYS configures a dedicated agent (new whole-space, new
 *     this-project-only, or an existing one; there is no run-as-your-own-user
 *     option) and grants a new agent write access at the chosen scope;
 *   - write — `.me/config.yaml` (server/space/tree/agent). Harness surfaces
 *     (MCP, hooks, the injected shell contract) resolve this agent by
 *     config automatically; a stale `ME_AS_AGENT` pin in
 *     `.claude/settings.json`, written by an older `me project init`, is
 *     removed if present (it would otherwise silently override the
 *     injected `.me` sentinel).
 */
import * as clack from "@clack/prompts";
import { accessLevelName } from "@memory.build/protocol/space";
import { Command } from "commander";
import {
  applyCaptureDeselection,
  captureEnableStep,
} from "../agent/capture-step.ts";
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
  sameRulesFile,
  writeMemoryPointer,
} from "../agent/memory-pointer.ts";
import {
  type AgentProvisioningClients,
  provisionNewAgent,
} from "../agent/provision.ts";
import { transcriptImportStep } from "../agent/transcript-import-step.ts";
import { removeClaudeSettingsEnvKey } from "../claude/settings.ts";
import {
  type ResolvedCredentials,
  resolveCredentials,
  setActiveSpace,
} from "../credentials.ts";
import { claudeImporter } from "../importers/claude.ts";
import { codexImporter } from "../importers/codex.ts";
import { opencodeImporter } from "../importers/opencode.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat } from "../output.ts";
import { writeProjectConfig } from "../project-config.ts";
import { buildMemoryClient, buildUserClient, handleError } from "../util.ts";
import { pluginInstallAvailable, runClaudeInstallFlow } from "./claude.ts";
import { VALID_TREE_ROOT_RE } from "./import.ts";
import { runGitImport } from "./import-git.ts";
import { gitHookStatus, runGitHookInstall } from "./import-git-hook.ts";
import { openCodeSetupAvailable, runOpenCodeInstallFlow } from "./opencode.ts";

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

/** One harness offered by the preflight's setup multiselect. */
interface HarnessOffer {
  id: "claude" | "opencode";
  label: string;
  hint: string;
  /** Printed when the harness was offered but the user deselected it. */
  declinedWarning: string;
  install: () => Promise<void>;
}

/**
 * Preflight: a login session (required — the wizard lists spaces and creates
 * agents) and harness setup (recommended — capture/tools need it, but the
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

  // Harness setup: offer to install/configure every harness detected on this
  // machine but not yet set up. Skipped entirely — no prompt, no warnings —
  // once ANY harness is already configured, on the theory that once one is
  // set up you're already a Memory Engine user and per-project init
  // shouldn't nag about additional harnesses you may not use.
  const [claudeAvailability, openCodeAvailability] = await Promise.all([
    pluginInstallAvailable(),
    openCodeSetupAvailable(),
  ]);
  const alreadySetUp =
    claudeAvailability === "done" || openCodeAvailability === "done";
  if (!alreadySetUp) {
    const offers: HarnessOffer[] = [];
    if (claudeAvailability === "available") {
      offers.push({
        id: "claude",
        label: "Claude Code",
        hint: "plugin: hooks + slash commands + MCP",
        declinedWarning:
          "Continuing without the Claude Code plugin — session capture and the memory tools won't work until you run 'me claude install'.",
        install: () => runClaudeInstallFlow({ server: serverFlag }, globalOpts),
      });
    }
    if (openCodeAvailability === "available") {
      offers.push({
        id: "opencode",
        label: "OpenCode",
        hint: "capture plugin + MCP",
        declinedWarning:
          "Continuing without OpenCode setup — session capture and the memory tools won't work until you run 'me opencode install'.",
        install: () =>
          runOpenCodeInstallFlow({ server: serverFlag }, globalOpts),
      });
    }
    if (offers.length > 0) {
      const picked = await clack.multiselect({
        message:
          "Set up Memory Engine for the harnesses you use in this project?",
        options: offers.map((o) => ({
          value: o.id,
          label: o.label,
          hint: o.hint,
        })),
        initialValues: offers.map((o) => o.id),
        required: false,
      });
      // A cancelled multiselect declines everything (warns per offer) rather
      // than aborting the whole wizard — this step is recommended, not
      // required, same as declining used to be with a single confirm.
      const selected = clack.isCancel(picked) ? [] : picked;
      for (const offer of offers) {
        if (selected.includes(offer.id)) {
          // Frame what follows before delegating — the install flow's own
          // prompts (e.g. the capture opt-in) are worded generically since
          // they're shared with the standalone `me claude`/`me opencode
          // install` commands, so without this a question like "capture
          // your sessions?" reads as ambiguous mid-wizard: is it about this
          // project, or the whole machine? It's the latter. Indented a
          // couple of spaces (clack has no cross-call nesting primitive
          // that would let us truly indent the install flow's own prompts)
          // so it at least reads as visually offset from the wizard's own.
          clack.log.step(
            `  Setting up ${offer.label} — a one-time, machine-wide install, not specific to this project:`,
          );
          await offer.install();
        } else {
          clack.log.warn(`  ${offer.declinedWarning}`);
        }
      }
      // Close the digression — everything from here back down is this
      // project's own setup again.
      clack.log.step("Back to setting up this project:");
      creds = resolveCredentials(serverFlag);
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

  // Write the committed project config. The writer invalidates the
  // process-wide `.me` memo, so later phases resolve the fresh pin. Harness
  // surfaces resolve this `agent:` automatically (agent-by-config) — no
  // Claude settings.json pin needed.
  const configPath = writeProjectConfig(projectRoot, {
    server: creds.server,
    space: space.slug,
    tree,
    agent: choice.name,
  });
  clack.log.success(`Wrote ${configPath}`);

  // Clean up a stale ME_AS_AGENT pin from an older `me project init` — it
  // would otherwise silently override the injected `.me` sentinel.
  if (removeClaudeSettingsEnvKey(projectRoot, "ME_AS_AGENT")) {
    clack.log.success(
      "Removed the stale ME_AS_AGENT pin from .claude/settings.json (agent-by-config now resolves it from .me/config.yaml).",
    );
  }

  return { creds, projectRoot, space, tree, agent: choice.name };
}

/** The managed CLAUDE.md memory-pointer block the checklist upserts. */
const CLAUDE_MD_POINTER: MemoryPointerSpec = {
  filename: "CLAUDE.md",
  managedBy: "me project init",
  agentLabel: "Claude Code",
};

/** The managed AGENTS.md memory-pointer block the checklist upserts — the
 * OpenCode/Codex-side counterpart to CLAUDE_MD_POINTER above. */
const AGENTS_MD_POINTER: MemoryPointerSpec = {
  filename: "AGENTS.md",
  managedBy: "me project init",
  agentLabel: "your coding agent",
};

/**
 * CLAUDE_MD_POINTER, or its AGENTS_MD_POINTER-worded twin when CLAUDE.md and
 * AGENTS.md are symlinked together — a common convention for projects
 * supporting multiple AI tools with one shared instructions file. Both specs
 * already share the same start marker (`managedBy`), so writing each
 * independently into a symlinked pair wouldn't duplicate content — but it
 * WOULD silently clobber one write with the other's `agentLabel` wording,
 * non-deterministically depending on step order. Using the neutral wording
 * whenever the files are linked sidesteps that regardless of order; the
 * `agents-md` step below skips entirely in that case, since this step's
 * write already covers the (shared) file.
 */
async function claudeMdSpec(): Promise<MemoryPointerSpec> {
  return (await sameRulesFile("CLAUDE.md", "AGENTS.md"))
    ? { ...CLAUDE_MD_POINTER, agentLabel: AGENTS_MD_POINTER.agentLabel }
    : CLAUDE_MD_POINTER;
}

/**
 * The setup checklist (phase 3 of the wizard; the whole command when run
 * non-interactively). Moved from the retired `me claude init` — minus its
 * plugin-install step (now the wizard's preflight) and plus the
 * capture-enable step, which writes the project's committed `capture` flag.
 * The transcript-import and memory-pointer rows are harness-gated: each
 * transcript step (`transcriptImportStep`) hides itself when the project has
 * no sessions for that harness, and each pointer step hides itself when its
 * harness isn't installed on this machine at all — see `Bun.which` checks
 * below and `agent/transcript-import-step.ts`.
 */
const PROJECT_INIT_STEPS: InitStep[] = [
  transcriptImportStep("claude", claudeImporter, "Claude Code"),
  transcriptImportStep("codex", codexImporter, "Codex"),
  transcriptImportStep("opencode", opencodeImporter, "OpenCode"),
  captureEnableStep({
    group: "Session capture",
    toolLabel: "agent",
  }),
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
    // Hidden when Claude Code isn't installed on this machine at all; ✓ when
    // CLAUDE.md already carries the exact block this run would write — a
    // stale block (template or tree/space change) keeps the step offered so
    // the re-run refreshes it.
    available: async ({ server }) => {
      if (Bun.which("claude") === null) return "hidden";
      return (await memoryPointerUpToDate(await claudeMdSpec(), server))
        ? "done"
        : "available";
    },
    doneLabel: "Memory pointer already in CLAUDE.md",
    rerunLabel: "Rewrite the memory pointer in CLAUDE.md (already present)",
    run: async ({ server }) => writeMemoryPointer(await claudeMdSpec(), server),
  },
  {
    id: "agents-md",
    group: "Project config",
    kind: "config",
    optionKey: "skipAgentsMd",
    skipFlag: "--skip-agents-md",
    skipDescription:
      "do not write the memory pointer into the project's AGENTS.md",
    label: "Add a memory pointer to AGENTS.md",
    // Hidden unless OpenCode or Codex is installed on this machine — both
    // read AGENTS.md; also hidden when Claude Code is ALSO installed and
    // AGENTS.md is symlinked to CLAUDE.md, since the claude-md step's write
    // (via claudeMdSpec) already covers this exact physical file — running
    // this step too would just rewrite it a second time. ✓ when the file
    // already carries the exact block this run would write.
    available: async ({ server }) => {
      if (Bun.which("opencode") === null && Bun.which("codex") === null) {
        return "hidden";
      }
      if (
        Bun.which("claude") !== null &&
        (await sameRulesFile("CLAUDE.md", "AGENTS.md"))
      ) {
        return "hidden";
      }
      return (await memoryPointerUpToDate(AGENTS_MD_POINTER, server))
        ? "done"
        : "available";
    },
    doneLabel: "Memory pointer already in AGENTS.md",
    rerunLabel: "Rewrite the memory pointer in AGENTS.md (already present)",
    run: ({ server }) => writeMemoryPointer(AGENTS_MD_POINTER, server),
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
      "Ask your coding agent about this project's history or architecture —",
      "it now draws on the project's memories automatically, and consults",
      "them when exploring the code for new features.",
      "",
      "You can also point it at them explicitly, e.g.:",
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

      // Interactively deselecting the capture row is an explicit opt-out —
      // write `capture: false` (see applyCaptureDeselection).
      applyCaptureDeselection(result, {
        interactive,
        projectRoot: ctx.projectRoot,
      });

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
