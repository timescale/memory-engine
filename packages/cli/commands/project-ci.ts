/** GitHub Actions workflow setup for `me ci install`. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  DEFAULT_SERVER,
  type ResolvedCredentials,
  resolveCredentialsFor,
} from "../credentials.ts";
import { detectGitContext } from "../importers/project.ts";
import { getOutputFormat, type OutputFormat } from "../output.ts";
import {
  adminContactsFrom,
  buildMemoryClient,
  buildUserClient,
  handleError,
  isAppErrorCode,
  requireAuth,
  requireSession,
} from "../util.ts";

const execFileAsync = promisify(execFile);

export const WORKFLOW_RELPATH = ".github/workflows/me-import.yml";
export const DEFAULT_SECRET_NAME = "ME_API_KEY";
const SA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TREE_PATH_RE = /^~$|^(?:~[./]|\/)?[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
const SPACE_SLUG_RE = /^[a-z0-9]{12}$/;

interface CiInstallOptions {
  space?: string;
  tree?: string;
  secretName: string;
  serviceAccount?: string;
  createServiceAccount: boolean;
  workflowOnly: boolean;
  force: boolean;
}

export function parseGitHubRepo(remoteUrl: string): string | undefined {
  const match =
    /^git@github\.com:(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl) ??
    /^ssh:\/\/git@github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?$/.exec(
      remoteUrl,
    ) ??
    /^https?:\/\/github\.com\/(?<nwo>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      remoteUrl,
    );
  return match?.groups?.nwo;
}

export function renderWorkflow(opts: {
  secretName: string;
  space: string;
  tree: string;
  server?: string;
}): string {
  const server = opts.server ? `          ME_SERVER: ${opts.server}\n` : "";
  const env = `          ME_API_KEY: \${{ secrets.${opts.secretName} }}\n${server}          ME_SPACE: ${opts.space}`;
  return `name: Memory Engine import
on:
  push:
  workflow_dispatch: {}

concurrency:
  group: me-import-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  import:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - name: Install me
        run: |
          set -o pipefail
          mkdir -p "$HOME/.local/bin"
          curl -fsSL https://install.memory.build | ME_INSTALL_DIR="$HOME/.local/bin" sh
      - name: Import git history
        env:
${env}
        run: |
          "$HOME/.local/bin/me" import git --tree ${opts.tree}
      - name: Import docs
        env:
${env}
        run: |
          "$HOME/.local/bin/me" import docs . --git-aware --prune --tree ${opts.tree}
`;
}

/** Write the generated workflow, refusing an existing file unless forced. */
export function writeWorkflow(
  path: string,
  workflow: string,
  force: boolean,
): "created" | "replaced" {
  const exists = existsSync(path);
  if (exists && !force) {
    throw new Error(
      `${WORKFLOW_RELPATH} already exists; re-run with --force to replace it.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, workflow);
  return exists ? "replaced" : "created";
}

export function buildCiInstallOptions(
  raw: Record<string, unknown>,
): CiInstallOptions {
  const space = typeof raw.space === "string" ? raw.space : undefined;
  const tree = typeof raw.tree === "string" ? raw.tree : undefined;
  const secretName =
    typeof raw.secretName === "string" ? raw.secretName : DEFAULT_SECRET_NAME;
  const serviceAccount =
    typeof raw.serviceAccount === "string" ? raw.serviceAccount : undefined;
  if (space !== undefined && !SPACE_SLUG_RE.test(space)) {
    throw new Error(`Invalid --space: '${space}'.`);
  }
  if (
    tree !== undefined &&
    (!TREE_PATH_RE.test(tree) || tree.startsWith("~"))
  ) {
    throw new Error(`Invalid --tree: '${tree}'.`);
  }
  if (!SECRET_NAME_RE.test(secretName)) {
    throw new Error(`Invalid --secret-name: '${secretName}'.`);
  }
  if (serviceAccount !== undefined && !SA_NAME_RE.test(serviceAccount)) {
    throw new Error(`Invalid --service-account: '${serviceAccount}'.`);
  }
  if (raw.workflowOnly === true && raw.createServiceAccount === true) {
    throw new Error(
      "--workflow-only cannot be combined with --create-service-account.",
    );
  }
  return {
    space,
    tree,
    secretName,
    serviceAccount,
    createServiceAccount: raw.createServiceAccount === true,
    workflowOnly: raw.workflowOnly === true,
    force: raw.force === true,
  };
}

export function validateCiInstallMode(
  opts: CiInstallOptions,
  isInteractive: boolean,
): void {
  if (!isInteractive && !opts.workflowOnly && !opts.createServiceAccount) {
    throw new Error(
      "Non-interactive mode requires --workflow-only or --create-service-account.",
    );
  }
}

export function isEffectiveSpaceAdmin(
  spaces: Array<{ slug: string; admin: boolean }>,
  slug: string,
): boolean {
  return spaces.find((space) => space.slug === slug)?.admin === true;
}

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

async function ghReady(): Promise<boolean> {
  if (Bun.which("gh") === null) return false;
  try {
    await execFileAsync("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

type SecretPresence = "present" | "absent" | "unknown";

async function secretPresence(
  nwo: string,
  secretName: string,
): Promise<SecretPresence> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "secret",
      "list",
      "--repo",
      nwo,
      "--json",
      "name",
      "--jq",
      ".[].name",
    ]);
    if (stdout.split("\n").some((name) => name.trim() === secretName)) {
      return "present";
    }
  } catch {
    return "unknown";
  }
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/${nwo}/actions/organization-secrets`,
      "--jq",
      ".secrets[].name",
    ]);
    return stdout.split("\n").some((name) => name.trim() === secretName)
      ? "present"
      : "absent";
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return /HTTP 404/.test(stderr) ? "absent" : "unknown";
  }
}

async function ghSetSecret(
  nwo: string,
  secretName: string,
  value: string,
): Promise<void> {
  const proc = Bun.spawn(["gh", "secret", "set", secretName, "--repo", nwo], {
    stdin: new TextEncoder().encode(value),
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(
      `gh secret set failed: ${(await new Response(proc.stderr).text()).trim()}`,
    );
  }
}

function interactive(fmt: string): boolean {
  return (
    fmt === "text" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY)
  );
}

function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}

function defaultTree(repo: string): string {
  return `/share/projects/${repo}`;
}

function printInstructions(info: {
  space: string;
  tree: string;
  serviceAccount: string;
  secretName: string;
  repo: string;
  admins?: Array<{ email: string }>;
}): void {
  const admin = info.admins?.map((a) => a.email).join(", ") ?? "a space admin";
  clack.log.info(
    [
      `Ask ${admin} to run:`,
      `  me service create ${info.serviceAccount} --space ${info.space}`,
      `  me access grant write ${info.tree} ${info.serviceAccount} --space ${info.space}`,
      `  me apikey create --service ${info.serviceAccount} --space ${info.space}`,
      `  gh secret set ${info.secretName} --repo ${info.repo}`,
    ].join("\n"),
  );
}

/** Obtain the server's admin-contact enrichment without changing CI state. */
async function adminContactsForInstructions(
  creds: ResolvedCredentials,
  space: string,
): Promise<Array<{ email: string }> | undefined> {
  try {
    await buildMemoryClient({ ...creds, activeSpace: space }).principal.list();
    return undefined;
  } catch (error) {
    if (isAppErrorCode(error, "FORBIDDEN")) return adminContactsFrom(error);
    throw error;
  }
}

async function selectSpace(
  creds: ResolvedCredentials,
): Promise<{ slug: string; admin: boolean }> {
  const { spaces } = await buildUserClient(creds).space.list();
  if (spaces.length === 0) {
    throw new Error(
      "You do not belong to any spaces. Run 'me space create' or accept an invitation first.",
    );
  }
  const selected = unwrap(
    await clack.select({
      message: "Which space should CI import into?",
      options: spaces.map((space) => ({
        value: space.slug,
        label: space.name,
        hint: space.slug,
      })),
      initialValue: spaces.find((space) => space.slug === creds.activeSpace)
        ?.slug,
    }),
  );
  const space = spaces.find((item) => item.slug === selected);
  if (!space) throw new Error(`space '${selected}' disappeared`);
  return space;
}

async function createAndPlaceKey(info: {
  creds: ResolvedCredentials;
  fmt: OutputFormat;
  space: string;
  tree: string;
  serviceAccount: string;
  secretName: string;
  repo: string;
}): Promise<void> {
  requireAuth(info.creds, info.fmt);
  requireSession(info.creds, info.fmt);
  const user = buildUserClient(info.creds);
  const memory = buildMemoryClient({ ...info.creds, activeSpace: info.space });
  const { spaces } = await user.space.list();
  const space = spaces.find((item) => item.slug === info.space);
  if (!space) throw new Error(`Space '${info.space}' is not available.`);
  const who = await user.whoami();
  let serviceAccountId: string;
  try {
    const { principals } = await memory.principal.resolve({
      name: info.serviceAccount,
      kind: "s",
    });
    const existing = principals[0];
    if (existing) {
      serviceAccountId = existing.id;
    } else {
      const created = await user.serviceAccount.create({
        spaceId: space.id,
        name: info.serviceAccount,
        adminMembers: [{ memberId: who.id }],
      });
      serviceAccountId = created.serviceAccount.id;
    }
    await memory.grant.set({
      principalId: serviceAccountId,
      treePath: info.tree,
      access: 2,
    });
  } catch (error) {
    if (isAppErrorCode(error, "FORBIDDEN")) {
      printInstructions({ ...info, admins: adminContactsFrom(error) });
      throw error;
    }
    throw error;
  }

  const minted = await user.apiKey.create({
    memberId: serviceAccountId,
    name: `ci-import-${crypto.randomUUID().slice(0, 8)}`,
    expiresAt: null,
  });
  try {
    await ghSetSecret(info.repo, info.secretName, minted.key);
  } catch (error) {
    let revoked = false;
    try {
      revoked = (await user.apiKey.delete({ id: minted.id })).deleted;
    } catch {
      // The error below gives the operator the key id to revoke manually.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      revoked
        ? `${message}\nThe just-minted key was revoked.`
        : `${message}\nThe just-minted key could not be revoked. Revoke it with: me apikey delete ${minted.id}`,
    );
  }
}

export async function runCiInstall(
  rawOpts: Record<string, unknown>,
  globalOpts: Record<string, unknown>,
): Promise<void> {
  const fmt = getOutputFormat(globalOpts);
  let opts: CiInstallOptions;
  try {
    opts = buildCiInstallOptions(rawOpts);
  } catch (error) {
    handleError(error, fmt);
  }
  const isInteractive = interactive(fmt);
  try {
    validateCiInstallMode(opts, isInteractive);
  } catch (error) {
    handleError(error, fmt);
  }
  const { gitRoot } = await detectGitContext(process.cwd());
  if (!gitRoot)
    handleError(
      new Error("me ci install must run inside a git repository"),
      fmt,
    );
  const repo = await detectGitHubRepo(gitRoot);
  if (!repo)
    handleError(
      new Error("me ci install requires a GitHub origin remote"),
      fmt,
    );
  const workflowPath = join(gitRoot, WORKFLOW_RELPATH);
  if (existsSync(workflowPath) && !opts.force) {
    handleError(
      new Error(
        `${WORKFLOW_RELPATH} already exists; re-run with --force to replace it.`,
      ),
      fmt,
    );
  }
  if (!isInteractive && !opts.space) {
    handleError(
      new Error("--space is required when stdin/stdout are not TTYs."),
      fmt,
    );
  }

  // CI settings are explicit workflow inputs; a repository's retired .me
  // configuration must not influence this command.
  const creds = resolveCredentialsFor(undefined);
  let space = opts.space;
  let isAdmin = false;
  if (!space) {
    try {
      requireAuth(creds, fmt);
      const selected = await selectSpace(creds);
      space = selected.slug;
      isAdmin = isEffectiveSpaceAdmin([selected], selected.slug);
    } catch (error) {
      handleError(error, fmt, { creds, scope: "account" });
    }
  } else if (isInteractive && !opts.workflowOnly) {
    try {
      const { spaces } = await buildUserClient(creds).space.list();
      isAdmin = isEffectiveSpaceAdmin(spaces, space);
    } catch (error) {
      handleError(error, fmt, { creds, scope: "account" });
    }
  }
  const tree = opts.tree ?? defaultTree(repo.split("/")[1] ?? "repo");
  if (!TREE_PATH_RE.test(tree))
    handleError(new Error(`Invalid --tree: '${tree}'.`), fmt);
  const serviceAccount =
    opts.serviceAccount ?? `${repo.split("/")[1] ?? "repo"}-import`;
  const workflow = renderWorkflow({
    secretName: opts.secretName,
    space: space as string,
    tree,
    server: creds.server === DEFAULT_SERVER ? undefined : creds.server,
  });
  const writeGeneratedWorkflow = () => {
    try {
      const state = writeWorkflow(workflowPath, workflow, opts.force);
      if (fmt === "text")
        clack.log.success(
          `${state === "created" ? "Wrote" : "Replaced"} ${WORKFLOW_RELPATH}`,
        );
    } catch (error) {
      handleError(error, fmt);
    }
  };

  if (opts.workflowOnly) {
    writeGeneratedWorkflow();
    return;
  }
  if (!isInteractive && opts.createServiceAccount) {
    try {
      if (!(await ghReady()))
        throw new Error(
          "--create-service-account requires an authenticated gh CLI.",
        );
      const presence = await secretPresence(repo, opts.secretName);
      if (presence !== "absent") {
        throw new Error(
          presence === "present"
            ? `${opts.secretName} is already available to ${repo}; refusing to overwrite it in non-interactive mode.`
            : `Can't determine whether ${opts.secretName} is available to ${repo}.`,
        );
      }
      await createAndPlaceKey({
        creds,
        fmt,
        space: space as string,
        tree,
        serviceAccount,
        secretName: opts.secretName,
        repo,
      });
    } catch (error) {
      handleError(error, fmt, { creds, scope: "space" });
    }
    writeGeneratedWorkflow();
    return;
  }
  const choice = unwrap(
    await clack.select({
      message: "How should CI receive its ME_API_KEY?",
      options: isAdmin
        ? [
            {
              value: "existing",
              label: "I have a service account's ME_API_KEY",
            },
            { value: "create", label: "Create a service account" },
          ]
        : [
            {
              value: "existing",
              label: "I have a service account's ME_API_KEY",
            },
            { value: "instructions", label: "Give me instructions" },
          ],
    }),
  );
  if (choice === "instructions") {
    writeGeneratedWorkflow();
    try {
      printInstructions({
        space: space as string,
        tree,
        serviceAccount,
        secretName: opts.secretName,
        repo,
        admins: await adminContactsForInstructions(creds, space as string),
      });
    } catch (error) {
      handleError(error, fmt, { creds, scope: "space" });
    }
    return;
  }
  if (!(await ghReady())) {
    handleError(
      new Error(
        "An authenticated gh CLI is required to place a repository secret.",
      ),
      fmt,
    );
  }
  if (choice === "existing") {
    const presence = await secretPresence(repo, opts.secretName);
    if (presence === "unknown") {
      handleError(
        new Error(
          `Can't determine whether ${opts.secretName} is available to ${repo}.`,
        ),
        fmt,
      );
    }
    if (presence === "present") {
      const overwrite = unwrap(
        await clack.confirm({
          message: `${opts.secretName} already exists. Overwrite it?`,
          initialValue: false,
        }),
      );
      if (!overwrite) return;
    }
    const key = unwrap(
      await clack.password({ message: "Service account ME_API_KEY:" }),
    );
    try {
      await ghSetSecret(repo, opts.secretName, key);
    } catch (error) {
      handleError(error, fmt);
    }
    writeGeneratedWorkflow();
    return;
  }
  try {
    const presence = await secretPresence(repo, opts.secretName);
    if (presence === "unknown") {
      throw new Error(
        `Can't determine whether ${opts.secretName} is available to ${repo}.`,
      );
    }
    if (presence === "present") {
      const overwrite = unwrap(
        await clack.confirm({
          message: `${opts.secretName} already exists. Overwrite it?`,
          initialValue: false,
        }),
      );
      if (!overwrite) return;
    }
    await createAndPlaceKey({
      creds,
      fmt,
      space: space as string,
      tree,
      serviceAccount,
      secretName: opts.secretName,
      repo,
    });
  } catch (error) {
    handleError(error, fmt, { creds, scope: "space" });
  }
  writeGeneratedWorkflow();
}

export function createCiInstallCommand(): Command {
  const ci = new Command("ci").description(
    "set up a GitHub Actions workflow that imports this repository",
  );
  ci.command("install")
    .description("generate .github/workflows/me-import.yml")
    .option("--space <slug>", "Memory Engine space (required off-TTY)")
    .option(
      "--tree <path>",
      "destination tree (default: /share/projects/<repo>)",
    )
    .option(
      "--secret-name <name>",
      `GitHub secret name (default: ${DEFAULT_SECRET_NAME})`,
    )
    .option(
      "--service-account <name>",
      "service account name (default: <repo>-import)",
    )
    .option(
      "--create-service-account",
      "create credentials and place them in the repository secret",
    )
    .option("--workflow-only", "write only the workflow")
    .option("--force", "replace an existing workflow file")
    .action(async (opts, cmd) => runCiInstall(opts, cmd.optsWithGlobals()));
  return ci;
}
