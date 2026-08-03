/** ME-managed deployment inventory for harness integrations. */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { HarnessName } from "./names.ts";

const artifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mcp-cli"),
      server_name: z.literal("me"),
      scope: z.enum(["user", "project"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp-json"),
      path: z.string().min(1),
      server_name: z.literal("me"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plugin"),
      marketplace: z.string().min(1),
      plugin: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("json-hook"),
      path: z.string().min(1),
      event: z.string().min(1),
      command: z.string().min(1),
    })
    .strict(),
]);

const installationSchema = z
  .object({
    installed_at: z.string().datetime({ offset: true }),
    me_version: z.string().min(1),
    artifacts: z.array(artifactSchema),
  })
  .strict();

const harnessesSchema = z
  .object({
    claude: installationSchema.optional(),
    opencode: installationSchema.optional(),
    codex: installationSchema.optional(),
    gemini: installationSchema.optional(),
  })
  .strict();

const installationsSchema = z
  .object({
    version: z.literal(1),
    harnesses: harnessesSchema,
  })
  .strict();

export type InstallationArtifact = z.infer<typeof artifactSchema>;
export type HarnessInstallation = z.infer<typeof installationSchema>;
export type InstallationsFile = z.infer<typeof installationsSchema>;

function getConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "me");
}

export function getInstallationsPath(): string {
  return join(getConfigDir(), "installations.yaml");
}

function emptyInstallations(): InstallationsFile {
  return { version: 1, harnesses: {} };
}

export function readInstallations(): InstallationsFile {
  const path = getInstallationsPath();
  if (!existsSync(path)) return emptyInstallations();
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = installationsSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${path} is invalid${issue?.path.length ? ` (field '${issue.path.join(".")}')` : ""}: ${issue?.message ?? "does not match installations.yaml v1"}`,
    );
  }
  return result.data;
}

function ensureSafeConfigDir(): string {
  const dir = dirname(getInstallationsPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(
      `Refusing to write installations inventory through symlinked config directory: ${dir}`,
    );
  }
  chmodSync(dir, 0o700);
  return dir;
}

function writeInstallations(file: InstallationsFile): void {
  const path = getInstallationsPath();
  const dir = ensureSafeConfigDir();
  const temporaryPath = join(dir, `.installations.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, stringify(file), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) {
      // A failed rename leaves no inventory update behind.
      unlinkSync(temporaryPath);
    }
  }
}

function withInventoryLock<T>(action: () => T): T {
  ensureSafeConfigDir();
  const lock = `${getInstallationsPath()}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        return action();
      } finally {
        rmdirSync(lock);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(
    `Timed out waiting for installations inventory lock: ${lock}`,
  );
}

export function getInstallation(
  harness: HarnessName,
): HarnessInstallation | undefined {
  return readInstallations().harnesses[harness];
}

export function writeInstallation(
  harness: HarnessName,
  installation: HarnessInstallation,
): void {
  withInventoryLock(() => {
    const file = readInstallations();
    writeInstallations({
      ...file,
      harnesses: { ...file.harnesses, [harness]: installation },
    });
  });
}

export function removeInstallation(harness: HarnessName): void {
  withInventoryLock(() => {
    const file = readInstallations();
    if (!(harness in file.harnesses)) return;
    const { [harness]: _, ...harnesses } = file.harnesses;
    writeInstallations({ ...file, harnesses });
  });
}

/** True only when an installed file remains byte-identical to our record. */
export function fileMatchesArtifact(
  artifact: Extract<InstallationArtifact, { kind: "file" }>,
): boolean {
  try {
    const digest = createHash("sha256")
      .update(readFileSync(artifact.path))
      .digest("hex");
    return digest === artifact.sha256;
  } catch {
    return false;
  }
}
