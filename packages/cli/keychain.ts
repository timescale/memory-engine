/**
 * OS keychain for the CLI session token, with a 0600-file fallback.
 *
 * The session token is the only secret the CLI persists. When an OS secret
 * store is available we keep it there (one entry per server origin); otherwise
 * the caller falls back to the 0600 credentials file. Backends shell out to the
 * platform tool, so the compiled `me` binary needs no native module:
 *
 *   - macOS:  `security` (the login keychain)
 *   - Linux:  `secret-tool` (libsecret / the Secret Service)
 *
 * Anything else (Windows, headless Linux without a Secret Service) reports
 * unavailable and the caller uses the file. Set `ME_NO_KEYCHAIN=1` to force the
 * file fallback everywhere (CI, debugging, sandboxes).
 *
 * Reads distinguish confirmed absence from a temporarily inaccessible store,
 * so callers do not mistake a locked store or spawn failure for logout.
 * Disabled / absent backends allow file fallback. The `account` is the
 * (normalized) server origin; the secret is the session token.
 */

/** Keychain service name — how the entries appear in Keychain Access / seahorse. */
const SERVICE = "memory.build";

/** A spawn timeout so a prompting/locked secret store can't hang the CLI. */
const SPAWN_TIMEOUT_MS = 5_000;

/** A failed lookup is not evidence that a credential was removed. */
export type KeychainRead =
  | { status: "found"; value: string }
  | { status: "missing" }
  | { status: "unavailable" };

interface Backend {
  get(account: string): KeychainRead;
  set(account: string, secret: string): boolean;
  del(account: string): void;
}

function keychainDisabled(): boolean {
  const v = process.env.ME_NO_KEYCHAIN;
  return v === "1" || v === "true";
}

/** Capture output internally; never expose command diagnostics to callers. */
function run(
  cmd: string[],
  stdin?: string,
): { exitCode: number; stdout: string; stderr: string } | null {
  try {
    const r = Bun.spawnSync({
      cmd,
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (r.exitedDueToTimeout || r.exitedDueToMaxBuffer || r.signalCode) {
      return null;
    }
    return {
      exitCode: r.exitCode ?? -1,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  } catch {
    return null;
  }
}

// macOS — the `security` CLI against the login keychain. The secret is passed
// via argv (-w); it is briefly visible to `ps`, but only to the same user, who
// can already read the 0600 fallback file.
const darwinBackend: Backend = {
  get(account) {
    const r = run([
      "security",
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (!r) return { status: "unavailable" };
    // errSecItemNotFound (-25300), modulo the shell's 8-bit exit status.
    if (r.exitCode === 44) return { status: "missing" };
    if (r.exitCode !== 0) return { status: "unavailable" };
    const out = r.stdout.replace(/\n$/, "");
    return out.length > 0
      ? { status: "found", value: out }
      : { status: "missing" };
  },
  set(account, secret) {
    const r = run([
      "security",
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      secret,
      "-U", // update the entry if it already exists
    ]);
    return r?.exitCode === 0;
  },
  del(account) {
    run(["security", "delete-generic-password", "-s", SERVICE, "-a", account]);
  },
};

// Linux — libsecret's `secret-tool` (Secret Service). The secret is read from
// stdin (never argv). `lookup` prints the secret with no trailing newline.
const linuxBackend: Backend = {
  get(account) {
    const r = run([
      "secret-tool",
      "lookup",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    if (!r) return { status: "unavailable" };
    // secret-tool reports a missing item as exit 1 without diagnostics.
    if (r.exitCode === 1 && r.stderr.length === 0) return { status: "missing" };
    if (r.exitCode !== 0) return { status: "unavailable" };
    return r.stdout.length > 0
      ? { status: "found", value: r.stdout }
      : { status: "missing" };
  },
  set(account, secret) {
    const r = run(
      [
        "secret-tool",
        "store",
        "--label=memory.build CLI session",
        "service",
        SERVICE,
        "account",
        account,
      ],
      secret,
    );
    return r?.exitCode === 0;
  },
  del(account) {
    run(["secret-tool", "clear", "service", SERVICE, "account", account]);
  },
};

let resolved: Backend | null | undefined;

/** The backend for this host, or null when no keychain is usable. Memoized. */
function backend(): Backend | null {
  if (resolved !== undefined) return resolved;
  resolved = selectBackend();
  return resolved;
}

function selectBackend(): Backend | null {
  if (keychainDisabled()) return null;
  if (process.platform === "darwin") return darwinBackend;
  if (process.platform === "linux" && Bun.which("secret-tool")) {
    return linuxBackend;
  }
  return null;
}

/** Reset the memoized backend — for tests that toggle `ME_NO_KEYCHAIN`. */
export function resetKeychainForTests(): void {
  resolved = undefined;
}

/** True if an OS keychain backend is available on this host. */
export function keychainAvailable(): boolean {
  return backend() !== null;
}

/** Read a secret without conflating confirmed absence with lookup failure. */
export function keychainRead(account: string): KeychainRead {
  try {
    const b = backend();
    return b ? b.get(account) : { status: "missing" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Compatibility wrapper: undefined if absent / unavailable. */
export function keychainGet(account: string): string | undefined {
  const result = keychainRead(account);
  return result.status === "found" ? result.value : undefined;
}

/** Store the secret for `account`. Returns true iff it landed in the keychain. */
export function keychainSet(account: string, secret: string): boolean {
  const b = backend();
  if (!b) return false;
  try {
    return b.set(account, secret);
  } catch {
    return false;
  }
}

/** Remove the secret for `account` (no-op if absent / unavailable). */
export function keychainDelete(account: string): void {
  const b = backend();
  if (!b) return;
  try {
    b.del(account);
  } catch {
    // best-effort
  }
}
