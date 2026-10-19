/** Non-secret, XDG-independent credential authority and pathname identities. */
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type CredentialAuthority =
  | { version: 1; source: "keychain" }
  | { version: 1; source: "file"; path: string }
  | { version: 1; source: "logged_out" };

export type AuthorityRead =
  | { status: "found"; authority: CredentialAuthority }
  | { status: "missing" }
  | { status: "unavailable" };

/**
 * Resolve symlinks even when the leaf (or its parent) does not exist yet. Use
 * this pathname for BOTH I/O and locks: atomic rename changes inode identity,
 * and renaming over a symlink instead of its target would split the stores.
 * No directories are created by path calculation or reads.
 */
export function canonicalCredentialPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (lstatSync(absolute).isSymbolicLink())
      return canonicalCredentialPath(
        resolve(
          canonicalCredentialPath(dirname(absolute)),
          readlinkSync(absolute),
        ),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalCredentialPath(parent), basename(absolute));
}

/** Filesystem access failures only; never skip timeout or lost-lock exclusion. */
export function inaccessibleCredentialFile(error: unknown): boolean {
  return [
    "EACCES",
    "EPERM",
    "ENOTDIR",
    "EROFS",
    "ENOENT",
    "ELOOP",
    "EIO",
    "ENODEV",
    "ESTALE",
    "ETIMEDOUT",
    "ENAMETOOLONG",
    "ENOSPC",
    "EDQUOT",
    "EBUSY",
  ].includes((error as NodeJS.ErrnoException).code ?? "");
}

export function originKey(origin: string): string {
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

/** Respect the process HOME, including isolated/sandboxed homes (Bun caches os.homedir). */
export function credentialHomeDir(): string {
  return process.env.HOME || homedir();
}

/** Legacy default lock root; do not move it to the caller's custom XDG. */
export function credentialCoordinationDir(): string {
  return canonicalCredentialPath(join(credentialHomeDir(), ".config", "me"));
}

export function credentialAuthorityPath(origin: string): string {
  return join(
    credentialCoordinationDir(),
    `authority.${originKey(origin)}.json`,
  );
}

export function readCredentialAuthority(origin: string): AuthorityRead {
  try {
    const value: unknown = JSON.parse(
      readFileSync(credentialAuthorityPath(origin), "utf-8"),
    );
    if (value && typeof value === "object") {
      const candidate = value as Partial<CredentialAuthority>;
      if (candidate.version === 1) {
        if (
          candidate.source === "keychain" ||
          candidate.source === "logged_out"
        )
          return {
            status: "found",
            authority: { version: 1, source: candidate.source },
          };
        if (
          candidate.source === "file" &&
          typeof candidate.path === "string" &&
          isAbsolute(candidate.path)
        )
          return {
            status: "found",
            authority: {
              version: 1,
              source: "file",
              path: canonicalCredentialPath(candidate.path),
            },
          };
      }
    }
    return { status: "unavailable" };
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
    };
  }
}

/** Publish only after destination writes/retirement, while holding its locks. */
export function publishCredentialAuthority(
  origin: string,
  authority: CredentialAuthority,
): void {
  const path = credentialAuthorityPath(origin);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Construct the payload, never serialize a caller's object with extra fields.
    const metadata: CredentialAuthority =
      authority.source === "file"
        ? { version: 1, source: "file", path: authority.path }
        : { version: 1, source: authority.source };
    writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    throw new Error(
      "Cannot publish canonical credential authority. Restore write access to ~/.config/me, then retry; or use ME_NO_KEYCHAIN=1 with a writable XDG_CONFIG_HOME for a separate file-only login.",
      { cause: error },
    );
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Do not mask publication failure (or a completed atomic rename).
    }
  }
}
