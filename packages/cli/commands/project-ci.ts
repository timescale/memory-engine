/**
 * `me project ci` — set up (and maintain) the GitHub Actions import workflow.
 *
 * The CI import architecture is three layers (see CI_IMPORT_DESIGN.md): a
 * scaffolded, repo-agnostic workflow → the `me import ci` orchestrator → the
 * existing importers. This command owns the setup side:
 *
 *   1. workflow — write/update `.github/workflows/me-import.yml` with
 *      managed-file semantics (a marker line identifies our scaffold; a
 *      hand-maintained file is never silently clobbered). The scaffold
 *      carries no repo-specific values — the default branch is discovered at
 *      runtime by the workflow itself — so the only variable content is the
 *      secret name (`--key-name`) and, for a server outside the built-in
 *      trusted list, a baked-in `ME_SERVER`.
 *   2. identity + key — gated on ONE question: is the secret already
 *      available to the repo? Secrets are write-only, so presence is the only
 *      signal GitHub offers, and it can't distinguish "solo repo, nothing set
 *      up" from "org repo missing from the org secret's visibility list" —
 *      therefore provisioning is NEVER implicit: it happens only under
 *      `--create-service-account` or an interactive yes.
 *
 * Key-handling rule: a key is minted only when it has an immediate
 * destination — minted and piped straight into `gh secret set`, never
 * displayed or stored. Without `gh` (or on a decline) nothing is minted; the
 * exact commands are printed instead. This avoids orphan credentials: a
 * minted-but-unplaced key is live in scrollback with no home.
 *
 * An authority denial during provisioning is the expected common case (most
 * repo devs aren't space admins) and is not a dead end: the server enriches
 * the denial with the effective admins' contacts (see rpc/admin-contacts.ts),
 * and this command renders the two-command ask + self-serve retry.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  DEFAULT_SERVER,
  isDefaultTrustedServer,
  normalizeOrigin,
  type ResolvedCredentials,
  resolveCredentialsFor,
} from "../credentials.ts";
import { SlugRegistry } from "../importers/slug.ts";
import { getOutputFormat, output } from "../output.ts";
import {
  discoverProjectConfig,
  type ProjectConfig,
} from "../project-config.ts";
import {
  adminContactsFrom,
  buildMemoryClient,
  buildUserClient,
  handleError,
  isAppErrorCode,
  requireAuth,
  requireSession,
  requireSpace,
  resolveActiveSpace,
} from "../util.ts";
import { installedHookFile, stripHookBlock } from "./import-git-hook.ts";

const execFileAsync = promisify(execFile);

/** The scaffolded workflow's path, relative to the repo toplevel. */
export const WORKFLOW_RELPATH = ".github/workflows/me-import.yml";

/**
 * First line of our scaffold — the managed-file marker. Present → this
 * command may rewrite the file in place; absent on an existing file → the
 * file is hand-maintained and is never overwritten without confirmation.
 */
export const MANAGED_MARKER =
  "# Managed by 'me project ci' — re-run it to update; remove this line to hand-maintain.";

/** Default GitHub secret name (also the env var `me` reads — that never varies). */
export const DEFAULT_KEY_NAME = "ME_API_KEY";

/** Service-account name shape (mirrors principalHandleNameSchema). */
const SA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** GitHub Actions secret-name shape. */
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown by the shared body to end the run after output was rendered. */
class FinishSignal extends Error {
  constructor() {
    super("finished");
    this.name = "FinishSignal";
  }
}

/** Thrown (and caught by the init step) when setup ends pending, not failed. */
export class PendingSetup extends Error {
  constructor() {
    super("CI import setup pending");
    this.name = "PendingSetup";
  }
}

const isSignal = (e: unknown): boolean =>
  e instanceof FinishSignal || e instanceof PendingSetup;

/** Parsed options for one run. */
interface ProjectCiOptions {
  createServiceAccount: boolean;
  serviceAccount?: string;
  keyName?: string;
  rotateKey: boolean;
  dryRun: boolean;
}

/** Structured summary (the --json/--yaml output shape). */
interface ProjectCiResult {
  repo: string;
  workflow: "created" | "updated" | "unchanged" | "foreign" | "would-create";
  keyName: string;
  /** Secret visibility for the repo ("unknown" without a working gh). */
  secret: "present" | "absent" | "unknown" | "set" | "would-set";
  serviceAccount?: string;
  verified?: boolean;
  notes: string[];
}

// =============================================================================
// Pure helpers (exported for unit tests)
// =============================================================================

/** Parse a GitHub remote URL into "owner/repo", or undefined for non-GitHub. */
export function parseGitHubRepo(remoteUrl: string): string | undefined {
  const m =
    /^git@github\.com:(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl) ??
    /^ssh:\/\/git@github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/.exec(
      remoteUrl,
    ) ??
    /^https?:\/\/github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      remoteUrl,
    );
  return m?.groups?.nwo;
}

/**
 * Render the scaffold. Repo-agnostic by design: the default branch is
 * discovered at runtime (a scaffold-time name would silently rot on a
 * rename), so the same bytes work in every repo — an org can even distribute
 * the file without running this command.
 */
export function renderWorkflow(opts: {
  keyName: string;
  /** Baked in only when the resolved server differs from what a bare CI
   * checkout would resolve on its own (see workflowServerEnv). */
  serverEnv?: string;
}): string {
  const serverLine =
    opts.serverEnv === undefined
      ? ""
      : `          ME_SERVER: ${opts.serverEnv}\n`;
  return `${MANAGED_MARKER}
name: Memory Engine import
on:
  push: # all branches — the job itself gates on the default branch
  workflow_dispatch: {} # manual backfill / re-run

concurrency:
  group: me-import
  cancel-in-progress: true # newest run supersedes: every run is a full catch-up

jobs:
  import:
    # Default branch only, discovered at runtime — survives a rename, and
    # keeps this file identical across repos (no scaffold-time values).
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # REQUIRED — the git walk and docs git-date temporals need full history
      - name: Install me
        run: curl -fsSL https://install.memory.build | sh
      - name: Import
        env:
          ME_API_KEY: \${{ secrets.${opts.keyName} }}
${serverLine}        run: ~/.local/bin/me import ci
`;
}

/** Recover the secret name from an existing managed scaffold. */
export function recoverKeyNameFromWorkflow(
  content: string,
): string | undefined {
  const m = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(content);
  return m?.[1];
}

/** Segments of a tree path (display or dotted form), for ancestor checks. */
function treeSegments(path: string): string[] {
  return path
    .replace(/^\//, "")
    .split(/[./]/)
    .filter((s) => s.length > 0);
}

/** Whether `grants` includes write (level ≥ 2) at `tree` or an ancestor. */
export function hasWriteAtTree(
  grants: ReadonlyArray<{ treePath: string; access: number }>,
  tree: string,
): boolean {
  const target = treeSegments(tree);
  return grants.some((g) => {
    if (g.access < 2) return false;
    const anc = treeSegments(g.treePath);
    return (
      anc.length <= target.length && anc.every((seg, i) => seg === target[i])
    );
  });
}

/**
 * The `ME_SERVER` value to bake into the workflow, or undefined when a bare
 * CI checkout resolves the right server on its own: CI honors a committed
 * `.me` server only when it's in the BUILT-IN trusted list (no global
 * whitelist exists there), else falls back to the default server.
 */
export function workflowServerEnv(
  resolvedServer: string,
  project: Pick<ProjectConfig, "server"> | undefined,
): string | undefined {
  const resolved = normalizeOrigin(resolvedServer);
  const ciResolves =
    project?.server !== undefined && isDefaultTrustedServer(project.server)
      ? normalizeOrigin(project.server)
      : DEFAULT_SERVER;
  return resolved === ciResolves ? undefined : resolved;
}

// =============================================================================
// git / gh subprocess helpers
// =============================================================================

/** The repo's "owner/repo" from its origin remote, or undefined. */
async function detectGitHubRepo(gitRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      gitRoot,
      "remote",
      "get-url",
      "origin",
    ]);
    return parseGitHubRepo(stdout.trim());
  } catch {
    return undefined;
  }
}

/** Whether the `gh` CLI is installed and authenticated. */
async function ghReady(): Promise<boolean> {
  if (Bun.which("gh") === null) return false;
  try {
    await execFileAsync("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a secret named `keyName` is visible to the repo — repo-level, or
 * provided by an org secret whose visibility list includes this repo (the
 * org variant). "unknown" when gh can't answer (insufficient repo access) —
 * treated as cannot-verify, never as absent.
 */
async function secretPresence(
  nwo: string,
  keyName: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    const repo = await execFileAsync("gh", [
      "secret",
      "list",
      "--repo",
      nwo,
      "--json",
      "name",
      "--jq",
      ".[].name",
    ]);
    if (repo.stdout.split("\n").some((n) => n.trim() === keyName)) {
      return "present";
    }
  } catch {
    return "unknown";
  }
  // Org-provided secrets are NOT in `gh secret list` — they come from the
  // repo's organization-secrets endpoint. A failure here (404 for user-owned
  // repos, 403 without access) means "no org secrets visible", not unknown —
  // the repo-level check above already succeeded.
  try {
    const org = await execFileAsync("gh", [
      "api",
      `repos/${nwo}/actions/organization-secrets`,
      "--jq",
      ".secrets[].name",
    ]);
    if (org.stdout.split("\n").some((n) => n.trim() === keyName)) {
      return "present";
    }
  } catch {
    // fall through — treated as no org secrets
  }
  return "absent";
}

/** `gh secret set` with the value on stdin (never in argv). */
async function ghSetSecret(
  nwo: string,
  keyName: string,
  value: string,
): Promise<void> {
  const proc = Bun.spawn(["gh", "secret", "set", keyName, "--repo", nwo], {
    stdin: new TextEncoder().encode(value),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`gh secret set failed: ${stderr.trim()}`);
  }
}

// =============================================================================
// The run
// =============================================================================

/** A minted-key name that never collides across rotations. */
function mintedKeyName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % 36];
  return `ci-import-${suffix}`;
}

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
 * Render the escalation block for an admin-gated denial: the effective
 * admins (from the enriched error) plus the exact commands to ask them to
 * run, and the self-serve retry. Returns true when the error was rendered
 * (a FORBIDDEN); false → the caller falls through to handleError.
 */
function renderAdminAsk(
  error: unknown,
  info: {
    saName: string;
    tree: string;
    callerEmail?: string;
    spaceSlug: string;
  },
): boolean {
  if (!isAppErrorCode(error, "FORBIDDEN")) return false;
  const admins = adminContactsFrom(error);
  const adminLines =
    admins === undefined
      ? ["  (ask a space admin)"]
      : admins.map((a) => `  ${a.email}`);
  const adminFlag = info.callerEmail ? ` --admin ${info.callerEmail}` : "";
  clack.log.error(
    error instanceof Error ? error.message : "This requires a space admin.",
  );
  clack.log.info(
    [
      `Space admins for ${info.spaceSlug}:`,
      ...adminLines,
      "Ask one of them to run:",
      `  me service create ${info.saName}${adminFlag}`,
      `  me access grant write ${info.tree} ${info.saName}`,
      ...(info.callerEmail
        ? [
            `(--admin ${info.callerEmail} puts you in the service account's bound`,
            " admin group — key management is then yours, no further admin needed.)",
          ]
        : []),
      "Then re-run:",
      "  me project ci",
      "It will find the service account, mint the key, and set the repo secret itself.",
    ].join("\n"),
  );
  return true;
}

/** Validate raw Commander opts into a typed option set. */
export function buildProjectCiOptions(
  opts: Record<string, unknown>,
): ProjectCiOptions {
  const serviceAccount =
    typeof opts.serviceAccount === "string" ? opts.serviceAccount : undefined;
  if (serviceAccount !== undefined && !SA_NAME_RE.test(serviceAccount)) {
    throw new Error(
      `Invalid --service-account: '${serviceAccount}' is not a valid principal name.`,
    );
  }
  const keyName = typeof opts.keyName === "string" ? opts.keyName : undefined;
  if (keyName !== undefined && !KEY_NAME_RE.test(keyName)) {
    throw new Error(
      `Invalid --key-name: '${keyName}' — GitHub secret names are [A-Za-z_][A-Za-z0-9_]*.`,
    );
  }
  return {
    createServiceAccount: opts.createServiceAccount === true,
    serviceAccount,
    keyName,
    rotateKey: opts.rotateKey === true,
    dryRun: opts.dryRun === true,
  };
}

/**
 * Run the setup end-to-end. With `fromInit`, hard stops become a
 * {@link PendingSetup} throw (caught by the init step) instead of a non-zero
 * exit, so a pending state — "ask your admin" — never aborts the wizard's
 * remaining steps: the scaffold that DID land still counts, and setup
 * completes on a later `me project ci` run.
 */
export async function runProjectCi(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
  runCtx: { fromInit?: boolean } = {},
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  try {
    await runProjectCiBody(rawOpts, globalOpts, runCtx);
  } catch (e) {
    if (e instanceof FinishSignal) {
      return; // output already rendered; exit 0 via normal return
    }
    throw e;
  }
}

async function runProjectCiBody(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
  runCtx: { fromInit?: boolean },
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  const interactive =
    fmt === "text" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY);
  /** A hard stop: pending (init) or error exit (standalone). */
  const fail = (message: string): never => {
    if (runCtx.fromInit) {
      clack.log.warn(`${message}\n(CI import setup left pending.)`);
      throw new PendingSetup();
    }
    handleError(new Error(message), fmt);
  };

  let opts: ProjectCiOptions;
  try {
    opts = buildProjectCiOptions(rawOpts);
  } catch (error) {
    handleError(error, fmt);
  }

  // ---- Resolve the repo, its GitHub identity, and the project config ------
  const { gitRoot } = await new SlugRegistry().resolve(process.cwd());
  if (gitRoot === undefined) {
    throw fail("me project ci must run inside a git repository");
  }
  const nwo = await detectGitHubRepo(gitRoot);
  if (nwo === undefined) {
    throw fail(
      "No GitHub origin remote found — the scaffolded workflow is GitHub Actions. " +
        "For other CI systems, call `me import ci` from your own pipeline.",
    );
  }

  let project: ProjectConfig | undefined;
  let creds: ResolvedCredentials;
  try {
    project = discoverProjectConfig(gitRoot);
    creds = resolveCredentialsFor(project);
  } catch (error) {
    if (isSignal(error)) throw error;
    handleError(error, fmt);
  }

  // The CI run authenticates as a service account resolving the committed
  // `.me`: it needs a pinned space (no ME_SPACE exists in CI) and a pinned,
  // non-home tree (service accounts have no `~` — a home-rooted tree
  // resolves to nothing for them).
  const tree = project?.tree;
  if (project?.space === undefined || tree === undefined) {
    throw fail(
      "The CI import needs a committed .me/config.yaml pinning `space` and `tree` " +
        "(run `me project init` first).",
    );
  }
  if (tree.startsWith("~")) {
    throw fail(
      `The project tree '${tree}' is home-rooted — a service account has no home. ` +
        "Pin a shared tree (e.g. /share/projects/<name>) in .me/config.yaml.",
    );
  }

  const notes: string[] = [];
  const repoName = nwo.split("/")[1] ?? "repo";
  const saName =
    opts.serviceAccount ??
    project.import?.service_account ??
    `${repoName}-import`;
  const saNamedExplicitly =
    opts.serviceAccount !== undefined ||
    project.import?.service_account !== undefined;

  // ---- Phase 1: the workflow scaffold --------------------------------------
  const workflowPath = join(gitRoot, WORKFLOW_RELPATH);
  const existing = existsSync(workflowPath)
    ? readFileSync(workflowPath, "utf-8")
    : undefined;
  const existingManaged = existing?.startsWith(MANAGED_MARKER) ?? false;
  const keyName =
    opts.keyName ??
    (existing !== undefined && existingManaged
      ? recoverKeyNameFromWorkflow(existing)
      : undefined) ??
    DEFAULT_KEY_NAME;
  const desired = renderWorkflow({
    keyName,
    serverEnv: workflowServerEnv(creds.server, project),
  });

  let workflowState: ProjectCiResult["workflow"];
  if (existing === undefined) {
    workflowState = opts.dryRun ? "would-create" : "created";
  } else if (!existingManaged) {
    workflowState = "foreign";
  } else {
    workflowState = existing === desired ? "unchanged" : "updated";
  }

  if (workflowState === "foreign" && interactive && !opts.dryRun) {
    const overwrite = unwrap(
      await clack.confirm({
        message: `${WORKFLOW_RELPATH} exists but isn't managed by me project ci — overwrite it with the scaffold?`,
        initialValue: false,
      }),
    );
    if (overwrite) workflowState = "updated";
  }
  if (workflowState === "foreign") {
    notes.push(
      `${WORKFLOW_RELPATH} exists and isn't managed by me project ci — left untouched.`,
    );
  }
  if (
    !opts.dryRun &&
    (workflowState === "created" || workflowState === "updated")
  ) {
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, desired);
  }
  if (fmt === "text") {
    clack.log.step(
      {
        created: `Wrote ${WORKFLOW_RELPATH}`,
        updated: `Updated ${WORKFLOW_RELPATH}`,
        unchanged: `${WORKFLOW_RELPATH} is up to date`,
        foreign: `${WORKFLOW_RELPATH} left untouched (not managed by me project ci)`,
        "would-create": `Would write ${WORKFLOW_RELPATH}`,
      }[workflowState],
    );
  }

  // ---- Phase 2: secret presence --------------------------------------------
  const gh = await ghReady();
  const presence: ProjectCiResult["secret"] = gh
    ? await secretPresence(nwo, keyName)
    : "unknown";
  if (fmt === "text") {
    if (presence === "present") {
      clack.log.step(`Found ${keyName} — secret already available to ${nwo}`);
    } else if (presence === "absent") {
      clack.log.step(
        `No ${keyName} secret found for ${nwo} (checked repo and org secrets)`,
      );
    } else {
      clack.log.warn(
        `Can't check for an existing ${keyName} secret — 'gh' is ${
          Bun.which("gh") === null
            ? "not installed"
            : "not authenticated (or lacks access to this repo)"
        }.`,
      );
    }
  }

  const result: ProjectCiResult = {
    repo: nwo,
    workflow: workflowState,
    keyName,
    secret: presence,
    notes,
  };
  /** A text-mode progress line (structured modes keep stdout clean). */
  const step = (msg: string): void => {
    if (fmt === "text") clack.log.step(msg);
  };

  /**
   * Migration from the retired `me import git-hook`: an installed hook keeps
   * firing `me import git` on every local commit (importing unmerged work)
   * until its managed block is stripped — and the `--remove` path is gone
   * with the command, so this is the supported removal. Runs only once CI
   * credentials are in place (`ready`): stripping earlier would open a
   * capture gap between "hook gone" and "CI not yet importing".
   */
  const migrateInstalledHook = async (ready: boolean): Promise<void> => {
    if (opts.dryRun) return;
    const hooksFile = await installedHookFile(gitRoot);
    if (hooksFile === undefined) return;
    if (!ready) {
      notes.push(
        `A retired 'me import git-hook' block is still installed (${hooksFile}); it will be removed once CI credentials are set up.`,
      );
      return;
    }
    const strip = interactive
      ? unwrap(
          await clack.confirm({
            message:
              "A retired 'me import git-hook' post-commit hook is installed — remove it? (CI now owns git imports; the local hook also imports unmerged commits.)",
            initialValue: true,
          }),
        )
      : true;
    if (strip) {
      await stripHookBlock(hooksFile);
      step(`Removed the retired post-commit hook block from ${hooksFile}`);
    } else {
      notes.push(
        "Kept the local post-commit hook — it imports unmerged commits; remove its '>>> memory-engine' block when ready.",
      );
    }
  };

  /**
   * Render the summary and end the run (unwinds via FinishSignal). MUST be
   * awaited: output()'s structured write is async, and the process exits
   * right after the command action resolves — an unawaited write is lost.
   * `credentialsReady` gates the retired-hook migration (see above).
   */
  const finish = async (
    extra?: Partial<ProjectCiResult> & { credentialsReady?: boolean },
  ): Promise<never> => {
    const { credentialsReady, ...rest } = extra ?? {};
    await migrateInstalledHook(credentialsReady === true);
    Object.assign(result, rest);
    await output(result, fmt, () => {
      for (const n of notes) clack.log.info(n);
      if (
        !opts.dryRun &&
        (workflowState === "created" || workflowState === "updated")
      ) {
        clack.log.info(
          `Commit ${WORKFLOW_RELPATH} — imports start on the next push to the default branch (the first run backfills history).`,
        );
      }
    });
    throw new FinishSignal();
  };

  if (opts.dryRun) {
    if (opts.rotateKey) {
      notes.push(
        `Would mint a new key for '${saName}' and update the ${keyName} secret.`,
      );
    } else if (presence !== "present") {
      notes.push(
        `Would ${opts.createServiceAccount || interactive ? "offer to " : ""}provision service account '${saName}' ` +
          `with write on ${tree}, mint a key, and set the ${keyName} secret.`,
      );
    }
    throw await finish();
  }

  // ---- Phase 3: secret present → verify (when an identity is named) --------
  if (presence === "present" && !opts.rotateKey && !opts.createServiceAccount) {
    if (!saNamedExplicitly) {
      notes.push(
        "Using the existing secret. (A secret's contents can't be read back — the first workflow run verifies it, and fails loudly.)",
      );
      throw await finish({ credentialsReady: true });
    }
    requireAuth(creds, fmt);
    requireSpace(creds, fmt);
    const user = buildUserClient(creds);
    const memory = buildMemoryClient(creds);
    try {
      const space = await resolveActiveSpace(
        user,
        creds.activeSpace ?? "",
        fmt,
      );
      const { serviceAccounts } = await user.serviceAccount.list({
        spaceId: space.id,
      });
      const sa = serviceAccounts.find(
        (a) => a.name.toLowerCase() === saName.toLowerCase(),
      );
      if (!sa) {
        throw fail(
          `Service account '${saName}' does not exist — but the ${keyName} secret is set, so it can't be holding ` +
            "that account's key. Run `me project ci --create-service-account` to provision consistently " +
            "(it will ask before overwriting the secret).",
        );
      }
      const { grants } = await memory.grant.list({ principalId: sa.id });
      if (hasWriteAtTree(grants, tree)) {
        step(`Verified: '${saName}' holds write on ${tree}`);
        throw await finish({
          serviceAccount: saName,
          verified: true,
          credentialsReady: true,
        });
      }
      const applyGrant = interactive
        ? unwrap(
            await clack.confirm({
              message: `'${saName}' has no write grant on ${tree} — grant it now?`,
            }),
          )
        : true; // a named SA is the operator's stated intent
      if (applyGrant) {
        await memory.grant.set({
          principalId: sa.id,
          treePath: tree,
          access: 2,
        });
        step(`Granted write on ${tree} to '${saName}'`);
      }
      throw await finish({
        serviceAccount: saName,
        verified: applyGrant,
        credentialsReady: true,
      });
    } catch (error) {
      if (isSignal(error)) throw error;
      if (isAppErrorCode(error, "FORBIDDEN")) {
        // grant.list on another principal is admin-gated: verify degrades to
        // a note rather than blocking a setup that may be perfectly fine.
        notes.push(
          `Couldn't verify '${saName}' (requires admin/owner authority). The first workflow run verifies end-to-end.`,
        );
        throw await finish({
          serviceAccount: saName,
          verified: false,
          credentialsReady: true,
        });
      }
      handleError(error, fmt, { creds, scope: "space" });
    }
  }

  // ---- Phase 4: provisioning gate -------------------------------------------
  let provision = opts.createServiceAccount || opts.rotateKey;
  if (!provision) {
    if (presence === "unknown") {
      throw fail(
        `Can't check whether the ${keyName} secret exists ('gh' unavailable). Install and authenticate gh, ` +
          "set the secret manually, or re-run with --create-service-account to provision.",
      );
    }
    if (!interactive) {
      throw fail(
        `No ${keyName} secret is available to ${nwo}. Either ask your org admin to add this repo to the ` +
          "org secret's visibility list, or re-run with --create-service-account to provision repo-scoped credentials.",
      );
    }
    const choice = unwrap(
      await clack.select({
        message: `No ${keyName} secret found. Provision CI credentials now?`,
        options: [
          {
            value: "create",
            label: "Yes — create a repo-scoped service account",
          },
          {
            value: "abort",
            label: "No — an org secret is expected",
            hint: "ask an org admin to add this repo to its visibility list",
          },
        ],
      }),
    ) as string;
    if (choice !== "create") {
      notes.push(
        "Skipped provisioning — ask an org admin to expose the org secret to this repo.",
      );
      throw await finish();
    }
    provision = true;
  }

  // ---- Phase 5: provision (ensure SA + grant; mint only into the secret) ---
  requireAuth(creds, fmt);
  requireSpace(creds, fmt);
  requireSession(creds, fmt); // key minting is session-only
  const user = buildUserClient(creds);
  const memory = buildMemoryClient(creds);
  const spaceSlug = creds.activeSpace ?? "the space";
  let callerEmail: string | undefined;
  let callerId = "";
  let spaceId = "";
  try {
    const who = await user.whoami();
    callerEmail = who.email ?? undefined;
    callerId = who.id;
    const space = await resolveActiveSpace(user, creds.activeSpace ?? "", fmt);
    spaceId = space.id;
  } catch (error) {
    if (isSignal(error)) throw error;
    handleError(error, fmt, { creds, scope: "space" });
  }

  const finalName =
    interactive && !opts.rotateKey
      ? unwrap(
          await clack.text({
            message: "Service account name:",
            initialValue: saName,
            validate: (v) =>
              SA_NAME_RE.test(v ?? "")
                ? undefined
                : "not a valid principal name",
          }),
        )
      : saName;

  let saId = "";
  try {
    const { serviceAccounts } = await user.serviceAccount.list({ spaceId });
    const existingSa = serviceAccounts.find(
      (a) => a.name.toLowerCase() === finalName.toLowerCase(),
    );
    if (existingSa) {
      saId = existingSa.id;
      step(`Service account '${finalName}' already exists`);
    } else if (opts.rotateKey) {
      throw fail(
        `--rotate-key: service account '${finalName}' does not exist. Provision first with --create-service-account.`,
      );
    } else {
      // The caller seeds the bound admin group so key management (and future
      // rotation) is self-serve — no dependency on the creating admin.
      const { serviceAccount } = await user.serviceAccount.create({
        spaceId,
        name: finalName,
        adminMembers: [{ memberId: callerId }],
      });
      saId = serviceAccount.id;
      step(
        `Created service account '${finalName}' (you are in its bound admin group)`,
      );
    }
  } catch (error) {
    if (isSignal(error)) throw error;
    if (
      fmt === "text" &&
      renderAdminAsk(error, { saName: finalName, tree, callerEmail, spaceSlug })
    ) {
      if (runCtx.fromInit) throw new PendingSetup();
      process.exit(1);
    }
    handleError(error, fmt, { creds, scope: "space" });
  }

  // Grant write at the project tree (idempotent; a denial names the admins).
  try {
    const { grants } = await memory.grant.list({ principalId: saId });
    if (hasWriteAtTree(grants, tree)) {
      step(`'${finalName}' already holds write on ${tree}`);
    } else {
      await memory.grant.set({ principalId: saId, treePath: tree, access: 2 });
      step(`Granted write on ${tree} to '${finalName}'`);
    }
  } catch (error) {
    if (isSignal(error)) throw error;
    if (
      fmt === "text" &&
      renderAdminAsk(error, { saName: finalName, tree, callerEmail, spaceSlug })
    ) {
      if (runCtx.fromInit) throw new PendingSetup();
      process.exit(1);
    }
    handleError(error, fmt, { creds, scope: "space" });
  }

  // ---- Phase 6: key + secret — mint ONLY when piping into gh secret set ----
  if (!gh) {
    notes.push(
      "No key was minted ('gh' unavailable — a key is minted only when it can go straight into the secret).",
      "Run these together once gh is ready:",
      `  me apikey create --service ${finalName}`,
      `  gh secret set ${keyName} --repo ${nwo}   # paste the key`,
    );
    throw await finish({ serviceAccount: finalName });
  }
  if (presence === "present" && !opts.rotateKey) {
    // Reached only via --create-service-account with a secret already set:
    // a new repo-level secret would shadow it (e.g. an org secret).
    const overwrite = interactive
      ? unwrap(
          await clack.confirm({
            message: `A ${keyName} secret is already visible to ${nwo} — a new repo-level secret will shadow it. Overwrite?`,
            initialValue: false,
          }),
        )
      : false;
    if (!overwrite) {
      notes.push("Kept the existing secret; no key was minted.");
      throw await finish({ serviceAccount: finalName, credentialsReady: true });
    }
  }
  const setNow = interactive
    ? unwrap(
        await clack.confirm({
          message: `Set repo secret ${keyName} on ${nwo} via gh?`,
          initialValue: true,
        }),
      )
    : true;
  if (!setNow) {
    notes.push(
      "No key was minted (a key is minted only when it can go straight into the secret).",
      "To finish, run these together:",
      `  me apikey create --service ${finalName}`,
      `  gh secret set ${keyName} --repo ${nwo}   # paste the key`,
    );
    throw await finish({ serviceAccount: finalName });
  }
  try {
    const name = mintedKeyName();
    const minted = await user.apiKey.create({
      memberId: saId,
      name,
      expiresAt: null,
    });
    await ghSetSecret(nwo, keyName, minted.key);
    step(
      `Minted api key "${name}" → gh secret set ${keyName} (piped directly; never displayed or stored)`,
    );
    if (opts.rotateKey) {
      notes.push(
        `Rotated. Revoke old keys: me apikey list --service ${finalName}, then me apikey delete --service ${finalName} <key>.`,
      );
    }
  } catch (error) {
    if (isSignal(error)) throw error;
    handleError(error, fmt, { creds, scope: "space" });
  }
  throw await finish({
    serviceAccount: finalName,
    secret: "set",
    credentialsReady: true,
  });
}

/** `me project ci` subcommand factory. */
export function createProjectCiCommand(): Command {
  return new Command("ci")
    .description(
      "set up the GitHub Actions import workflow (scaffold + service-account credentials)",
    )
    .option(
      "--create-service-account",
      "provision repo-scoped credentials without prompting (the TTY prompt's headless spelling)",
    )
    .option(
      "--service-account <name>",
      "the service account expected to hold the CI credentials (default: .me import.service_account, else <repo>-import)",
    )
    .option(
      "--key-name <secret-name>",
      `GitHub secret name (default: ${DEFAULT_KEY_NAME}; recovered from an existing managed workflow)`,
    )
    .option(
      "--rotate-key",
      "mint a new key for the service account and update the secret",
    )
    .option("--dry-run", "report what would happen without writing anything")
    .action(async (opts, cmdRef) => {
      const globalOpts = cmdRef.optsWithGlobals();
      await runProjectCi(opts, globalOpts);
    });
}

/**
 * Init-step availability for the `ci-workflow` step: hidden outside a git
 * repo or without a GitHub remote; "done" when the managed scaffold is
 * already current (setup may still be pending secret-side — re-runs are
 * offered as idempotent).
 */
export async function ciWorkflowStatus(
  cwd: string,
): Promise<"hidden" | "done" | "available"> {
  try {
    const { gitRoot } = await new SlugRegistry().resolve(cwd);
    if (gitRoot === undefined) return "hidden";
    const nwo = await detectGitHubRepo(gitRoot);
    if (nwo === undefined) return "hidden";
    const workflowPath = join(gitRoot, WORKFLOW_RELPATH);
    if (!existsSync(workflowPath)) return "available";
    const existing = readFileSync(workflowPath, "utf-8");
    if (!existing.startsWith(MANAGED_MARKER)) return "available";
    const project = discoverProjectConfig(gitRoot);
    const creds = resolveCredentialsFor(project);
    const desired = renderWorkflow({
      keyName: recoverKeyNameFromWorkflow(existing) ?? DEFAULT_KEY_NAME,
      serverEnv: workflowServerEnv(creds.server, project),
    });
    return existing === desired ? "done" : "available";
  } catch {
    return "available";
  }
}
