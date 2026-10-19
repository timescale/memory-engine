/**
 * Credential mutation boundary: canonical origin/authority lock first, followed
 * by sorted whole-file locks. Login authorization stays OUTSIDE this boundary.
 * No nested acquisition: the locked context pins the source through exchange.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type AuthorityRead,
  type CredentialAuthority,
  credentialAuthorityPath,
  inaccessibleCredentialFile,
  originKey,
  publishCredentialAuthority,
  readCredentialAuthority,
} from "./credential-authority.ts";
import {
  type CredentialWriteTarget,
  clearTokens,
  getCredentialLockPath,
  getCredentialsPath,
  getGlobalConfigPath,
  normalizeOrigin,
  type OAuthTokenSet,
  readFileTokens,
  readLegacyCredentialSource,
  readTokensFromAuthority,
  type StoredTokensRead,
  storeTokens,
  writeCurrentTokens,
} from "./credentials.ts";
import { keychainAvailable } from "./keychain.ts";

/** Sentinel: the lock could not be acquired within the deadline. */
export const LOCK_TIMEOUT = Symbol("refresh-lock-timeout");
const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 45_000;
const LOCK_POLL_MS = 25;
const LOCK_HEARTBEAT_MS = 5_000;

/** @internal Test-only lock timing overrides. One deadline covers ALL resources. */
export interface LockOptions {
  acquireTimeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

/** @internal Legacy default per-origin lock identity is deliberately retained. */
export function lockPath(server: string, createDirectory = true): string {
  return getCredentialLockPath(
    `refresh.${originKey(normalizeOrigin(server))}.lock`,
    createDirectory,
  );
}

/** Non-writing session identity, independent of how many locks are acquired. */
export function credentialScope(server: string): string {
  const origin = normalizeOrigin(server);
  return keychainAvailable()
    ? credentialAuthorityPath(origin)
    : `${getCredentialsPath()}:${origin}`;
}

export interface CredentialMutationContext {
  /** Non-secret session identity captured before the exchange. */
  readonly scope: string;
  /** Read only the authority pinned under lock, never search alternate stores. */
  read(): StoredTokensRead;
  /** Background rotation/rejection: keep the authoritative file, if any. */
  writeCurrent(tokens: OAuthTokenSet): void;
}

type Intent = "background" | "login" | "logout";

/**
 * Adopt the released file-first legacy source before background mutation.
 * Inaccessible legacy storage needs explicit recovery; no guesses about
 * chronology, alternate reads, or arbitrary XDG directory scans.
 */
function pinnedTarget(
  origin: string,
  layout: LockedLayout,
  intent: Intent,
): CredentialWriteTarget {
  let authority: CredentialAuthority;
  if (layout.published?.status === "found") {
    authority = layout.published.authority;
  } else if (layout.keychain && intent === "background") {
    const legacy = readLegacyCredentialSource(origin, layout.fallbackPath);
    if (!legacy.authority)
      throw new Error(
        "Credential stores disagree or cannot be read. Run 'me login' to sign in again.",
      );
    authority = legacy.authority;
    layout.assertOwned();
    publishCredentialAuthority(origin, authority);
  } else {
    authority = { version: 1, source: "file", path: layout.fallbackPath };
  }
  return {
    keychain: layout.keychain,
    authority,
    fallbackPath: layout.fallbackPath,
    retirePaths: layout.files,
    lockedPaths: layout.files,
    recoverUnreadableFiles: intent !== "background" && layout.keychain,
  };
}

export async function withCredentialMutation<T>(
  server: string,
  action: (context: CredentialMutationContext) => Promise<T>,
  options?: LockOptions,
): Promise<T | typeof LOCK_TIMEOUT> {
  const origin = normalizeOrigin(server);
  return withLockedResources(
    server,
    async (layout) => {
      const target = pinnedTarget(origin, layout, "background");
      return action({
        scope: layout.keychain
          ? credentialAuthorityPath(origin)
          : `${layout.fallbackPath}:${origin}`,
        read: () => {
          try {
            layout.assertOwned();
            return readTokensFromAuthority(origin, target.authority);
          } catch {
            // A lookup/ownership failure is never evidence of logout. In
            // particular it cannot turn invalid_grant into a storage error.
            return { status: "unavailable" };
          }
        },
        writeCurrent: (tokens) => {
          layout.assertOwned();
          writeCurrentTokens(origin, tokens, target);
        },
      });
    },
    "background",
    options,
  );
}

/** Explicit login may deliberately select a NEW backend and default server. */
export async function persistLoginTokens(
  server: string,
  tokens: OAuthTokenSet,
): Promise<void> {
  const origin = normalizeOrigin(server);
  const result = await withLockedResources(
    server,
    async (layout) => {
      const target = pinnedTarget(origin, layout, "login");
      layout.assertOwned();
      storeTokens(origin, tokens, { target });
    },
    "login",
  );
  if (result === LOCK_TIMEOUT)
    throw new Error("Credential store is busy. Try again.");
}

/** Durable logged_out publication prevents failed keychain deletion resurrection. */
export async function logoutCredentials(server: string): Promise<void> {
  const origin = normalizeOrigin(server);
  const result = await withLockedResources(
    server,
    async (layout) => {
      const target = pinnedTarget(origin, layout, "logout");
      layout.assertOwned();
      clearTokens(origin, target);
    },
    "logout",
  );
  if (result === LOCK_TIMEOUT)
    throw new Error("Credential store is busy. Try again.");
}

/**
 * @internal Compatibility lock API. Holds the same resource set as mutations,
 * but does not adopt/publish legacy state. Never call a mutation API inside it.
 */
export async function withRefreshLock<T>(
  server: string,
  action: () => Promise<T>,
  options?: LockOptions,
): Promise<T | typeof LOCK_TIMEOUT> {
  return withLockedResources(
    server,
    async () => action(),
    "background",
    options,
  );
}

interface LockedLayout {
  keychain: boolean;
  fallbackPath: string;
  files: string[];
  published?: AuthorityRead;
  assertOwned(): void;
}

/**
 * File-only clients touch only their private XDG store, including read-only HOME
 * sandboxes. Keychain clients fail closed if their canonical HOME lock is not
 * writable; using another XDG root would split authority. Old custom-XDG clients
 * that do not implement these resource locks are outside this protocol.
 */
async function withLockedResources<T>(
  server: string,
  action: (layout: LockedLayout) => Promise<T>,
  intent: Intent,
  options?: LockOptions,
): Promise<T | typeof LOCK_TIMEOUT> {
  const deadline =
    Date.now() + (options?.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS);
  const owner = randomUUID();
  const held: string[] = [];
  const heartbeat = setInterval(() => {
    for (const lock of held) {
      try {
        if (readFileSync(join(lock, "owner"), "utf-8") === owner) {
          const now = new Date();
          utimesSync(lock, now, now);
        }
      } catch {
        // A handoff must not mutate a successor. Writes verify ownership too.
      }
    }
  }, options?.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  const assertOwned = () => {
    for (const lock of held) {
      if (readFileSync(join(lock, "owner"), "utf-8") !== owner)
        throw new Error("Credential store lock was lost. Try again.");
    }
  };
  const acquire = async (lock: string) => {
    if (held.includes(lock)) return true;
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    if (!(await acquireResource(lock, owner, deadline, options))) return false;
    held.push(lock);
    return true;
  };
  try {
    const keychain = keychainAvailable();
    // Keep a legacy per-origin compatibility lock in file-only stores as well.
    // It is always BEFORE the file lock, so overlapping default paths dedup and
    // mixed-mode acquisition cannot introduce a lock-order cycle.
    try {
      if (!(await acquire(lockPath(server, false)))) return LOCK_TIMEOUT;
    } catch (error) {
      if (!keychain) throw error;
      throw new Error(
        "Cannot lock canonical credential authority. Restore write access to ~/.config/me, then retry; or use ME_NO_KEYCHAIN=1 with a writable XDG_CONFIG_HOME for a separate file-only login.",
        { cause: error },
      );
    }
    const recover = keychain && intent !== "background";
    // Unknown/bad authority is replaceable metadata ONLY for explicit intent.
    // Never use it to search for an alternate credential on a background read.
    const published = keychain
      ? readCredentialAuthority(normalizeOrigin(server))
      : undefined;
    if (published?.status === "unavailable" && !recover)
      throw new Error(
        "Credential authority cannot be read. Restore access to ~/.config/me or use explicit login/logout to replace damaged metadata.",
      );
    let fallbackPath: string;
    let fallbackResolved = true;
    try {
      fallbackPath = getCredentialsPath();
    } catch (error) {
      if (!recover || !inaccessibleCredentialFile(error)) throw error;
      // This placeholder must NEVER be used for writes: it is not in files.
      fallbackPath = join(dirname(getGlobalConfigPath()), "credentials.yaml");
      fallbackResolved = false;
    }
    const candidates = [
      ...new Set([
        ...(fallbackResolved ? [fallbackPath] : []),
        ...(published?.status === "found" &&
        published.authority.source === "file"
          ? [published.authority.path]
          : []),
      ]),
    ].sort();
    const files: string[] = [];
    for (const path of candidates) {
      try {
        // A live-lock timeout is exclusion, NOT an inaccessible private file.
        if (!(await acquire(`${path}.lock`))) return LOCK_TIMEOUT;
        files.push(path);
      } catch (error) {
        if (!recover || !inaccessibleCredentialFile(error)) throw error;
        // A readable live record cannot be silently stranded just because its
        // directory is read-only. Only missing/unreadable resources qualify for
        // explicit global recovery without retirement in the owning environment.
        if (readFileTokens(normalizeOrigin(server), path).status === "found")
          throw new Error(
            "Credential file is readable but cannot be locked for retirement. Restore write access to its directory, then retry login or logout.",
          );
        // Canonical publication can retire this path for global keychain
        // clients, but file-only clients must clear it in their own environment.
      }
    }
    assertOwned();
    return await action({
      keychain,
      fallbackPath,
      files,
      published,
      assertOwned,
    });
  } finally {
    clearInterval(heartbeat);
    for (const lock of held.reverse()) {
      try {
        const marker = join(lock, "owner");
        if (readFileSync(marker, "utf-8") === owner) {
          unlinkSync(marker);
          rmdirSync(lock);
        }
      } catch {
        // Never remove a successor's lock after reclamation/handoff.
      }
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireResource(
  lock: string,
  owner: string,
  deadline: number,
  options?: LockOptions,
): Promise<boolean> {
  const staleMs = options?.staleMs ?? LOCK_STALE_MS;
  const pollMs = options?.pollMs ?? LOCK_POLL_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(join(lock, "owner"), owner, { flag: "wx", mode: 0o600 });
      } catch (error) {
        try {
          rmdirSync(lock);
        } catch {
          // Preserve the marker-write failure rather than stranding our lock.
        }
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(lock).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
    if (mtimeMs !== undefined && Date.now() - mtimeMs > staleMs) {
      try {
        const stalePath = `${lock}.${randomUUID()}.stale`;
        renameSync(lock, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch {
        // Another waiter/owner changed it; retry the atomic mkdir.
      }
      if (Date.now() >= deadline) return false;
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
