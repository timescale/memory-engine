/**
 * Black-box cross-store regressions. Every credential operation runs in a real
 * child process, against real temporary credential files. The OS keychain and
 * OAuth endpoint are faked; resource/failure probes use child-local spies. Tests
 * never acquire production locks or publish authority through internal helpers.
 */
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthTokenSet, StoredTokensRead } from "./credentials.ts";

const SERVER = "https://credential-coordination.example.com";
const TEST_TIMEOUT = 25_000;
const modulePath = (name: string) =>
  fileURLToPath(new URL(name, import.meta.url));
const quoted = (value: unknown) => JSON.stringify(value);
const expired: OAuthTokenSet = {
  access_token: "access-0",
  refresh_token: "refresh-0",
  expires_at: 0,
};
const oldKeychain: OAuthTokenSet = {
  access_token: "retired-keychain-access",
  refresh_token: "retired-keychain-refresh",
  expires_at: 4_000_000_000_000,
};

type AccessResult =
  | { ok: true; token: string | null }
  | { ok: false; name: string; message: string };
interface Snapshot {
  read: StoredTokensRead;
  stored: OAuthTokenSet | null;
  access: AccessResult;
}
interface Exchange {
  refreshToken: string;
  accepted: boolean;
  pid: number;
}
interface Worker {
  process: ReturnType<typeof Bun.spawn>;
  output: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
interface WorkerOptions {
  xdg?: "a" | "b" | "default";
  home?: string;
  fileOnly?: boolean;
  id?: string;
  pauseExchange?: boolean;
}

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 6_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

class Fixture {
  // macOS /var is itself an alias. Keep fixture fault-match paths physical too.
  readonly root = realpathSync(
    mkdtempSync(join(tmpdir(), "me-store-coordination-")),
  );
  readonly home = join(this.root, "home");
  readonly xdg = { a: join(this.root, "xdg-a"), b: join(this.root, "xdg-b") };
  readonly keychain = join(this.root, "fake-keychain.json");
  private readonly children: Worker[] = [];
  private readonly releases = new Set<string>();

  constructor() {
    for (const directory of [this.home, this.xdg.a, this.xdg.b]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(this.keychain, "{}");
    this.setServerToken("refresh-0");
  }

  path(name: string): string {
    return join(this.root, name);
  }

  credentials(xdg: "a" | "b"): string {
    return join(this.xdg[xdg], "me", "credentials.yaml");
  }

  fail(operation: "set" | "delete", enabled: boolean): void {
    const path = this.path(`fail-keychain-${operation}`);
    if (enabled) writeFileSync(path, "fail");
    else rmSync(path, { force: true });
  }

  setServerToken(refreshToken: string): void {
    writeFileSync(
      this.path("oauth-state.json"),
      JSON.stringify({ refreshToken, generation: 0 }),
    );
  }

  exchanges(): Exchange[] {
    const path = this.path("exchanges.ndjson");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Exchange)
      : [];
  }

  release(name: string): void {
    writeFileSync(this.path(name), "release");
  }

  wait(name: string): Promise<void> {
    return waitUntil(() => existsSync(this.path(name)), name);
  }

  spawn(body: string, options: WorkerOptions = {}): Worker {
    const id = options.id ?? `worker-${this.children.length}`;
    const release = `release-${id}`;
    this.releases.add(release);
    // Strip ambient credential/profile routing and Bun preload configuration.
    // Child modules can never resolve the real HOME or real OS keychain.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("ME_") ||
        key.startsWith("BUN_") ||
        key.startsWith("LOGFIRE_") ||
        key === "AI_AGENT" ||
        key === "NODE_OPTIONS"
      ) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: options.home ?? this.home,
      USERPROFILE: options.home ?? this.home,
      XDG_CONFIG_HOME:
        options.xdg === "default" ? "" : this.xdg[options.xdg ?? "a"],
      XDG_DATA_HOME: this.path("data"),
      XDG_CACHE_HOME: this.path("cache"),
      XDG_STATE_HOME: this.path("state"),
      ME_NO_KEYCHAIN: options.fileOnly ? "1" : "0",
    });
    const source = `
      import { mock, spyOn } from "bun:test";
      import * as fs from "node:fs";
      import {
        appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
        rmdirSync, writeFileSync,
      } from "node:fs";
      const SERVER = ${quoted(SERVER)};
      const ROOT = ${quoted(this.root)};
      const KEYCHAIN = ${quoted(this.keychain)};
      const ID = ${quoted(id)};
      const marker = (name) => ROOT + "/" + name;
      const signal = (name) => writeFileSync(marker(name), "ready");
      const wait = async (name) => {
        const deadline = Date.now() + 10000;
        while (!existsSync(marker(name))) {
          if (Date.now() >= deadline) throw new Error("Release timeout: " + name);
          await Bun.sleep(5);
        }
      };
      const disabled = () => process.env.ME_NO_KEYCHAIN === "1";
      const readKeychain = (account) => {
        if (disabled()) return { status: "missing" };
        const contents = JSON.parse(readFileSync(KEYCHAIN, "utf8"));
        return typeof contents[account] === "string"
          ? { status: "found", value: contents[account] }
          : { status: "missing" };
      };
      const writeKeychain = (contents) => {
        const temporary = KEYCHAIN + "." + process.pid + ".tmp";
        writeFileSync(temporary, JSON.stringify(contents), { mode: 0o600 });
        renameSync(temporary, KEYCHAIN);
      };
      mock.module(${quoted(modulePath("./keychain.ts"))}, () => ({
        keychainAvailable: () => !disabled(),
        keychainRead: readKeychain,
        keychainGet: (account) => {
          const read = readKeychain(account);
          return read.status === "found" ? read.value : undefined;
        },
        keychainSet: (account, value) => {
          if (disabled() || existsSync(marker("fail-keychain-set"))) return false;
          const contents = JSON.parse(readFileSync(KEYCHAIN, "utf8"));
          contents[account] = value;
          writeKeychain(contents);
          return true;
        },
        keychainDelete: (account) => {
          if (disabled() || existsSync(marker("fail-keychain-delete"))) return;
          const contents = JSON.parse(readFileSync(KEYCHAIN, "utf8"));
          delete contents[account];
          writeKeychain(contents);
        },
        resetKeychainForTests: () => {},
      }));
      const { OAuthError } = await import(${quoted(modulePath("./oauth.ts"))});
      mock.module(${quoted(modulePath("./oauth.ts"))}, () => ({
        OAuthError,
        refreshTokens: async ({ refreshToken }) => {
          // This is a fake SERVER mutex, not the credential-store mutex. Consume
          // the RT and append the attempt atomically BEFORE any await or signal.
          // Duplicate callers therefore really receive invalid_grant, even while
          // the winner's response is paused at the barrier.
          const lock = marker("oauth-server.lock");
          const deadline = Date.now() + 2000;
          for (;;) {
            try { mkdirSync(lock); break; }
            catch (error) {
              if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            }
          }
          let accepted;
          let generation;
          try {
            const state = JSON.parse(readFileSync(marker("oauth-state.json"), "utf8"));
            accepted = state.refreshToken === refreshToken;
            generation = state.generation + 1;
            if (accepted) {
              writeFileSync(marker("oauth-state.json"), JSON.stringify({
                refreshToken: "refresh-" + generation, generation,
              }));
            }
            appendFileSync(marker("exchanges.ndjson"), JSON.stringify({
              refreshToken, accepted, pid: process.pid,
            }) + "\\n");
          } finally { rmdirSync(lock); }
          signal("exchange-" + ID);
          if (!accepted) throw new OAuthError("Refresh token already consumed", "invalid_grant");
          if (${quoted(options.pauseExchange ?? false)}) await wait(${quoted(release)});
          return {
            accessToken: "access-" + generation,
            refreshToken: "refresh-" + generation,
            expiresIn: 3600,
          };
        },
      }));
      const authority = await import(${quoted(modulePath("./credential-authority.ts"))});
      const credentials = await import(${quoted(modulePath("./credentials.ts"))});
      const mutation = await import(${quoted(modulePath("./credential-mutation.ts"))});
      const session = await import(${quoted(modulePath("./session.ts"))});
      const access = async (reactive = false) => {
        try {
          const token = await (reactive
            ? session.refreshAccessToken(SERVER)
            : session.getAccessToken(SERVER));
          return { ok: true, token: token ?? null };
        } catch (error) {
          return { ok: false, name: error.name, message: error.message };
        }
      };
      const attempt = async (action) => {
        try { await action(); return { ok: true }; }
        catch (error) { return { ok: false, name: error.name, message: error.message }; }
      };
      const stored = () => ({
        read: credentials.readStoredTokens(SERVER),
        stored: credentials.getStoredTokens(SERVER) ?? null,
      });
      const snapshot = async () => ({ ...stored(), access: await access() });
      const result = await (async () => { ${body} })();
      console.log(JSON.stringify(result ?? null));
    `;
    const child = Bun.spawn([process.execPath, "-e", source], {
      cwd: this.root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const worker: Worker = {
      process: child,
      // Drain both pipes immediately, including for deliberately blocked workers.
      output: Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr })),
    };
    this.children.push(worker);
    return worker;
  }

  async finish<T>(worker: Worker): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        worker.output,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Worker timed out")),
            12_000,
          );
        }),
      ]);
      expect({ exitCode: output.exitCode, stderr: output.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      return JSON.parse(output.stdout) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  run<T>(body: string, options?: WorkerOptions): Promise<T> {
    return this.finish<T>(this.spawn(body, options));
  }

  async login(tokens: OAuthTokenSet, options?: WorkerOptions): Promise<void> {
    await this.run(
      `await mutation.persistLoginTokens(SERVER, ${quoted(tokens)});`,
      options,
    );
  }

  read(options?: WorkerOptions): Promise<Snapshot> {
    return this.run("return await snapshot();", options);
  }

  async dispose(): Promise<void> {
    // Release response/reader barriers even after a failed assertion, then
    // kill/reap every child before deleting HOME, XDG stores, and fixture locks.
    for (const release of this.releases) this.release(release);
    this.release("release-readers");
    for (const child of this.children) {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
    }
    await Promise.all(this.children.map((child) => child.output));
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = new Fixture();
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

function expectFresh(
  snapshot: Snapshot,
  accessToken: string,
  refreshToken: string,
): void {
  expect(snapshot.read).toMatchObject({
    status: "found",
    tokens: { access_token: accessToken, refresh_token: refreshToken },
  });
  expect(snapshot.stored).toMatchObject({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  expect(snapshot.stored?.refresh_rejected).toBeUndefined();
  expect(snapshot.access).toEqual({ ok: true, token: accessToken });
}

function expectMissing(snapshot: Snapshot): void {
  expect(snapshot.read.status).toBe("missing");
  expect(snapshot.stored).toBeNull();
  expect(snapshot.access).toEqual({ ok: true, token: null });
}

for (const first of ["keychain-enabled", "file-only"] as const) {
  test(
    `published custom fallback serializes mixed-mode refreshes: ${first} first`,
    async () => {
      await withFixture(async (fixture) => {
        fixture.fail("set", true);
        await fixture.login(expired);
        // Recovery must not migrate a background refresh away from the shared file.
        fixture.fail("set", false);
        const leader = fixture.spawn("return await access();", {
          fileOnly: first === "file-only",
          id: "leader",
          pauseExchange: true,
        });
        await fixture.wait("exchange-leader");
        const waiter = fixture.spawn(
          `
        signal("waiter-started");
        const result = await access();
        signal("waiter-completed");
        return result;
      `,
          { fileOnly: first !== "file-only", id: "waiter" },
        );
        await fixture.wait("waiter-started");
        // The waiter has called the public API while the first response is held.
        await Bun.sleep(150);
        expect(existsSync(fixture.path("waiter-completed"))).toBe(false);
        expect(fixture.exchanges()).toHaveLength(1);
        fixture.release("release-leader");
        expect(await fixture.finish<AccessResult>(leader)).toEqual({
          ok: true,
          token: "access-1",
        });
        expect(await fixture.finish<AccessResult>(waiter)).toEqual({
          ok: true,
          token: "access-1",
        });
        expectFresh(await fixture.read(), "access-1", "refresh-1");
        expectFresh(
          await fixture.read({ fileOnly: true }),
          "access-1",
          "refresh-1",
        );
        expect(
          fixture
            .exchanges()
            .map(({ refreshToken, accepted }) => ({ refreshToken, accepted })),
        ).toEqual([{ refreshToken: "refresh-0", accepted: true }]);
      });
    },
    TEST_TIMEOUT,
  );
}

test(
  "a fresh explicit login from XDG B supersedes XDG A's fallback rejection, live and after restart",
  async () => {
    await withFixture(async (fixture) => {
      await fixture.login(oldKeychain);
      fixture.setServerToken("already-revoked");
      fixture.fail("set", true);
      // Force rejection through the public reactive path even though the old AT
      // has not expired. Keep this process alive to exercise its local hash guard.
      const rejectingA = fixture.spawn(
        `
      const rejected = await access(true);
      const tombstone = stored();
      signal("a-rejected");
      await wait("release-readers");
      return { rejected, tombstone, after: await snapshot() };
    `,
        { id: "a-reader" },
      );
      await fixture.wait("a-rejected");
      const readerB = fixture.spawn(
        `
      const before = await snapshot();
      signal("b-reading");
      await wait("release-readers");
      return { before, after: await snapshot() };
    `,
        { xdg: "b", id: "b-reader" },
      );
      await fixture.wait("b-reading");
      fixture.fail("set", false);
      await fixture.login(
        { access_token: "new-login", refresh_token: "new-login-refresh" },
        { xdg: "b" },
      );
      fixture.release("release-readers");
      const a = await fixture.finish<{
        rejected: AccessResult;
        tombstone: Pick<Snapshot, "read" | "stored">;
        after: Snapshot;
      }>(rejectingA);
      const b = await fixture.finish<{ before: Snapshot; after: Snapshot }>(
        readerB,
      );
      expect(a.rejected).toMatchObject({
        ok: false,
        name: "ReLoginRequiredError",
      });
      expect(a.tombstone.read.status).toBe("found");
      expect(a.tombstone.stored?.refresh_rejected).toMatch(/^[a-f0-9]{64}$/);
      expect(a.tombstone.stored?.refresh_token).toBeUndefined();
      expect(b.before.access).toMatchObject({
        ok: false,
        name: "ReLoginRequiredError",
      });
      expectFresh(a.after, "new-login", "new-login-refresh");
      expectFresh(b.after, "new-login", "new-login-refresh");
      for (const xdg of ["a", "b"] as const) {
        expectFresh(
          await fixture.read({ xdg }),
          "new-login",
          "new-login-refresh",
        );
      }
      // A file-only client cannot follow a keychain login. Its retired record may
      // be absent or terminal, but must not retain/replay the old raw RT.
      const retired = await fixture.read({ fileOnly: true });
      expect(retired.stored?.refresh_token).toBeUndefined();
      if (retired.access.ok) expect(retired.access.token).toBeNull();
      else expect(retired.access.name).toBe("ReLoginRequiredError");
      expect(fixture.exchanges()).toHaveLength(1);
      expect(fixture.exchanges()[0]).toMatchObject({
        refreshToken: oldKeychain.refresh_token,
        accepted: false,
      });
    });
  },
  TEST_TIMEOUT,
);

test(
  "explicit keychain login from B retires A's still-unconsumed fallback refresh token",
  async () => {
    await withFixture(async (fixture) => {
      fixture.fail("set", true);
      await fixture.login(expired);
      fixture.fail("set", false);
      await fixture.login(
        { access_token: "new-login", refresh_token: "new-login-refresh" },
        { xdg: "b" },
      );
      for (const xdg of ["a", "b"] as const) {
        expectFresh(
          await fixture.read({ xdg }),
          "new-login",
          "new-login-refresh",
        );
      }
      // Unlike the rejection case, this file still held a valid raw RT before
      // login switched authority. It must be retired, not left for a sandbox to
      // consume after other clients have moved to the new keychain login.
      const retired = await fixture.read({ fileOnly: true });
      expect(retired.stored?.refresh_token).toBeUndefined();
      if (retired.access.ok) expect(retired.access.token).toBeNull();
      else expect(retired.access.name).toBe("ReLoginRequiredError");
      expect(fixture.exchanges()).toHaveLength(0);
    });
  },
  TEST_TIMEOUT,
);

test(
  "XDG B follows published fallback A and keeps a recovered-keychain rotation visible to file-only A",
  async () => {
    await withFixture(async (fixture) => {
      await fixture.login(oldKeychain);
      fixture.fail("set", true);
      await fixture.login(expired);
      const fromB = await fixture.run<Pick<Snapshot, "read" | "stored">>(
        "return stored();",
        { xdg: "b" },
      );
      expect(fromB.read).toEqual({ status: "found", tokens: expired });
      expect(fromB.stored).toEqual(expired);
      fixture.fail("set", false);
      expect(
        await fixture.run<AccessResult>("return await access(true);", {
          xdg: "b",
        }),
      ).toEqual({ ok: true, token: "access-1" });
      expectFresh(
        await fixture.read({ fileOnly: true }),
        "access-1",
        "refresh-1",
      );
      expectFresh(await fixture.read({ xdg: "b" }), "access-1", "refresh-1");
      expectFresh(await fixture.read(), "access-1", "refresh-1");
      expect(fixture.exchanges()).toHaveLength(1);
      expect(fixture.exchanges()[0]).toMatchObject({
        refreshToken: "refresh-0",
        accepted: true,
      });
    });
  },
  TEST_TIMEOUT,
);

for (const source of ["keychain", "published fallback"] as const) {
  test(
    `explicit logout of ${source} survives failed keychain deletion and restart`,
    async () => {
      await withFixture(async (fixture) => {
        await fixture.login(oldKeychain);
        if (source === "published fallback") {
          fixture.fail("set", true);
          await fixture.login(expired);
          fixture.fail("set", false);
        }
        fixture.fail("delete", true);
        await fixture.run("await mutation.logoutCredentials(SERVER);", {
          xdg: "b",
        });
        // Verify the backend really still contains the stale secret: absence from
        // the public API must come from durable logout, not a successful delete.
        const residual = JSON.parse(
          readFileSync(fixture.keychain, "utf8"),
        ) as Record<string, string>;
        expect(JSON.parse(residual[SERVER] ?? "null")).toMatchObject(
          oldKeychain,
        );
        fixture.fail("delete", false);
        for (const xdg of ["a", "b"] as const) {
          expectMissing(await fixture.read({ xdg }));
          expectMissing(await fixture.read({ xdg })); // another independent restart
        }
        if (source === "published fallback") {
          expectMissing(await fixture.read({ fileOnly: true }));
        }
        expect(fixture.exchanges()).toHaveLength(0);
      });
    },
    TEST_TIMEOUT,
  );
}

for (const damage of ["missing", "corrupt"] as const) {
  test(
    `a ${damage} published fallback never revives stale keychain or private XDG credentials`,
    async () => {
      await withFixture(async (fixture) => {
        // This unrelated private B file must not override a published source, even
        // if the latter disappears. Seed via the public API, not fixture YAML.
        await fixture.login(
          { access_token: "private-b", refresh_token: "private-b-refresh" },
          { xdg: "b", fileOnly: true },
        );
        await fixture.login(oldKeychain);
        fixture.fail("set", true);
        await fixture.login(expired);
        fixture.fail("set", false);
        if (damage === "missing") rmSync(fixture.credentials("a"));
        else
          writeFileSync(fixture.credentials("a"), "servers: [unterminated\n");
        for (const xdg of ["a", "b"] as const) {
          const snapshot = await fixture.read({ xdg });
          expect(snapshot.read.status).toBe(
            damage === "missing" ? "missing" : "unavailable",
          );
          expect(snapshot.stored).toBeNull();
          expect(snapshot.access).toEqual({ ok: true, token: null });
        }
        expect(fixture.exchanges()).toHaveLength(0);
      });
    },
    TEST_TIMEOUT,
  );
}

interface MutationResult {
  ok: boolean;
  name?: string;
  message?: string;
}

function expectFileAuthority(fixture: Fixture, path: string): void {
  const directory = join(fixture.home, ".config", "me");
  const publications = readdirSync(directory).filter((name) =>
    /^authority\.[a-f0-9]+\.json$/.test(name),
  );
  expect(publications).toHaveLength(1);
  const payload = readFileSync(join(directory, publications[0] ?? ""), "utf8");
  // Exact shape: authority is only non-secret routing metadata, never tokens.
  expect(JSON.parse(payload)).toEqual({ version: 1, source: "file", path });
  for (const secret of [expired.access_token, expired.refresh_token]) {
    expect(payload).not.toContain(secret ?? "unused-secret");
  }
}

const activeFallback: OAuthTokenSet = {
  access_token: "active-fallback-access",
  refresh_token: "active-fallback-refresh",
  expires_at: 4_000_000_000_000,
};
const nextLogin: OAuthTokenSet = {
  access_token: "next-login-access",
  refresh_token: "next-login-refresh",
  expires_at: 4_000_000_000_000,
};

async function seedPublishedFallback(
  fixture: Fixture,
  tokens: OAuthTokenSet,
): Promise<void> {
  await fixture.login(oldKeychain);
  fixture.fail("set", true);
  await fixture.login(tokens);
  fixture.fail("set", false);
  expectFileAuthority(fixture, fixture.credentials("a"));
}

// These probes run after acquiring the production mutation boundary, but never
// invoke a lock helper themselves. Synchronous spies are confined to the child.
test(
  "different origins serialize on the whole fallback file and preserve both logins",
  async () => {
    await withFixture(async (fixture) => {
      const other = "https://other-credential-coordination.example.com";
      const leader = fixture.spawn(
        `
        const original = credentials.storeTokens;
        spyOn(credentials, "storeTokens").mockImplementation((...args) => {
          signal("whole-file-held");
          const deadline = Date.now() + 10000;
          while (!existsSync(marker("release-whole-file-leader"))) {
            if (Date.now() >= deadline) throw new Error("Store pause timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          return original(...args);
        });
        await mutation.persistLoginTokens(SERVER, ${quoted(activeFallback)});
        return stored();
      `,
        { fileOnly: true, id: "whole-file-leader" },
      );
      await fixture.wait("whole-file-held");
      expect(existsSync(`${fixture.credentials("a")}.lock/owner`)).toBe(true);
      const waiter = fixture.spawn(
        `
        signal("other-origin-started");
        await mutation.persistLoginTokens(${quoted(other)}, ${quoted(nextLogin)});
        signal("other-origin-completed");
        return credentials.getStoredTokens(${quoted(other)});
      `,
        { fileOnly: true, id: "other-origin" },
      );
      await fixture.wait("other-origin-started");
      await Bun.sleep(150);
      expect(existsSync(fixture.path("other-origin-completed"))).toBe(false);
      fixture.release("release-whole-file-leader");
      const first =
        await fixture.finish<Pick<Snapshot, "read" | "stored">>(leader);
      expect(first.stored).toEqual(activeFallback);
      expect(await fixture.finish<OAuthTokenSet>(waiter)).toEqual(nextLogin);
      const both = await fixture.run<{
        first: OAuthTokenSet;
        second: OAuthTokenSet;
      }>(
        `return {
          first: credentials.getStoredTokens(SERVER),
          second: credentials.getStoredTokens(${quoted(other)}),
        };`,
        { fileOnly: true },
      );
      expect(both).toEqual({ first: activeFallback, second: nextLogin });
      expect(fixture.exchanges()).toHaveLength(0);
    });
  },
  TEST_TIMEOUT,
);

for (const first of ["keychain-enabled", "file-only"] as const) {
  test(
    `symlinked credential aliases share one refresh without replacing the alias: ${first} first`,
    async () => {
      await withFixture(async (fixture) => {
        await seedPublishedFallback(fixture, expired);
        const alias = fixture.credentials("b");
        const target = fixture.credentials("a");
        mkdirSync(join(fixture.xdg.b, "me"), { recursive: true });
        symlinkSync(target, alias);
        const leader = fixture.spawn("return await access();", {
          xdg: first === "file-only" ? "b" : "a",
          fileOnly: first === "file-only",
          id: "alias-leader",
          pauseExchange: true,
        });
        await fixture.wait("exchange-alias-leader");
        const waiter = fixture.spawn(
          `
          signal("alias-waiter-started");
          const result = await access();
          signal("alias-waiter-completed");
          return result;
        `,
          {
            xdg: first === "file-only" ? "a" : "b",
            fileOnly: first !== "file-only",
            id: "alias-waiter",
          },
        );
        await fixture.wait("alias-waiter-started");
        await Bun.sleep(150);
        expect(existsSync(fixture.path("alias-waiter-completed"))).toBe(false);
        expect(fixture.exchanges()).toHaveLength(1);
        fixture.release("release-alias-leader");
        for (const worker of [leader, waiter]) {
          expect(await fixture.finish<AccessResult>(worker)).toEqual({
            ok: true,
            token: "access-1",
          });
        }
        expect(lstatSync(alias).isSymbolicLink()).toBe(true);
        expect(readlinkSync(alias)).toBe(target);
        for (const xdg of ["a", "b"] as const) {
          expectFresh(await fixture.read({ xdg }), "access-1", "refresh-1");
          expectFresh(
            await fixture.read({ xdg, fileOnly: true }),
            "access-1",
            "refresh-1",
          );
        }
        expectFileAuthority(fixture, target);
        expect(
          fixture
            .exchanges()
            .map(({ refreshToken, accepted }) => ({ refreshToken, accepted })),
        ).toEqual([{ refreshToken: "refresh-0", accepted: true }]);
      });
    },
    TEST_TIMEOUT,
  );
}

test(
  "default XDG overlapping the HOME coordination directory never acquires its own lock twice",
  async () => {
    await withFixture(async (fixture) => {
      fixture.fail("set", true);
      await fixture.login(expired, { xdg: "default" });
      fixture.fail("set", false);
      const leader = fixture.spawn("return await access();", {
        xdg: "default",
        id: "default-leader",
        pauseExchange: true,
      });
      await fixture.wait("exchange-default-leader");
      const waiter = fixture.spawn(
        `
        signal("default-waiter-started");
        const result = await access();
        signal("default-waiter-completed");
        return result;
      `,
        { xdg: "default", fileOnly: true, id: "default-waiter" },
      );
      await fixture.wait("default-waiter-started");
      await Bun.sleep(150);
      expect(existsSync(fixture.path("default-waiter-completed"))).toBe(false);
      fixture.release("release-default-leader");
      for (const worker of [leader, waiter]) {
        expect(await fixture.finish<AccessResult>(worker)).toEqual({
          ok: true,
          token: "access-1",
        });
      }
      expectFresh(
        await fixture.read({ xdg: "default" }),
        "access-1",
        "refresh-1",
      );
      expect(fixture.exchanges()).toHaveLength(1);
      await fixture.run("await mutation.logoutCredentials(SERVER);", {
        xdg: "default",
      });
      expectMissing(await fixture.read({ xdg: "default" }));
      expectMissing(await fixture.read({ xdg: "default", fileOnly: true }));
    });
  },
  TEST_TIMEOUT,
);

for (const homeKind of ["non-directory", "read-only"] as const) {
  test(
    `file-only login, refresh, rejection and logout never access a ${homeKind} HOME`,
    async () => {
      await withFixture(async (fixture) => {
        const home = fixture.path(`home-${homeKind}`);
        if (homeKind === "non-directory")
          writeFileSync(home, "not a directory");
        else {
          mkdirSync(home);
          chmodSync(home, 0o500);
        }
        try {
          const result = await fixture.run<{
            refreshed: AccessResult;
            rejected: AccessResult;
            rejectedAgain: AccessResult;
            tombstone: Pick<Snapshot, "read" | "stored">;
            fresh: Snapshot;
            logout: Snapshot;
            homeAccesses: string[];
          }>(
            `
            const homeAccesses = [];
            const home = ${quoted(home)};
            // Enforce the sandbox under privileged runners too: chmod alone
            // might not deny access. Every spy is child-local.
            for (const name of [
              "existsSync", "lstatSync", "realpathSync", "readlinkSync",
              "mkdirSync", "readFileSync", "writeFileSync", "renameSync",
              "unlinkSync", "rmdirSync", "statSync", "utimesSync",
            ]) {
              const original = fs[name];
              spyOn(fs, name).mockImplementation((...args) => {
                for (const arg of args.slice(0, name === "renameSync" ? 2 : 1)) {
                  if (typeof arg === "string" && (arg === home || arg.startsWith(home + "/"))) {
                    homeAccesses.push(name + ":" + arg);
                    throw new Error("Unexpected HOME access");
                  }
                }
                return original(...args);
              });
            }
            for (const name of [
              "credentialCoordinationDir", "credentialAuthorityPath",
              "readCredentialAuthority", "publishCredentialAuthority",
            ]) {
              spyOn(authority, name).mockImplementation(() => {
                homeAccesses.push(name);
                throw new Error("Unexpected HOME coordination access");
              });
            }
            await mutation.persistLoginTokens(SERVER, ${quoted(expired)});
            const refreshed = await access();
            writeFileSync(marker("oauth-state.json"), JSON.stringify({
              refreshToken: "revoked-by-server", generation: 1,
            }));
            const rejected = await access(true);
            const tombstone = stored();
            const rejectedAgain = await access();
            await mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)});
            const fresh = await snapshot();
            await mutation.logoutCredentials(SERVER);
            return { refreshed, rejected, rejectedAgain, tombstone, fresh,
              logout: await snapshot(), homeAccesses };
          `,
            { home, fileOnly: true },
          );
          expect(result.homeAccesses).toEqual([]);
          expect(result.refreshed).toEqual({ ok: true, token: "access-1" });
          for (const rejected of [result.rejected, result.rejectedAgain]) {
            expect(rejected).toMatchObject({
              ok: false,
              name: "ReLoginRequiredError",
            });
          }
          expect(result.tombstone.stored?.refresh_token).toBeUndefined();
          expect(result.tombstone.stored?.refresh_rejected).toMatch(
            /^[a-f0-9]{64}$/,
          );
          expectFresh(
            result.fresh,
            nextLogin.access_token,
            nextLogin.refresh_token ?? "",
          );
          expectMissing(result.logout);
          expect(
            fixture.exchanges().map(({ refreshToken, accepted }) => ({
              refreshToken,
              accepted,
            })),
          ).toEqual([
            { refreshToken: "refresh-0", accepted: true },
            { refreshToken: "refresh-1", accepted: false },
          ]);
        } finally {
          if (homeKind === "read-only") chmodSync(home, 0o700);
        }
      });
    },
    TEST_TIMEOUT,
  );
}

for (const operation of ["login", "logout"] as const) {
  test(
    `${operation} publication failure is reported without alternate-source resurrection after active-file retirement`,
    async () => {
      await withFixture(async (fixture) => {
        await fixture.login(
          { access_token: "private-b", refresh_token: "private-b-refresh" },
          { xdg: "b", fileOnly: true },
        );
        await seedPublishedFallback(fixture, activeFallback);
        const result = await fixture.run<{
          mutation: MutationResult;
          after: Snapshot;
          calls: number;
        }>(
          `
          let calls = 0;
          spyOn(authority, "publishCredentialAuthority").mockImplementation(() => {
            calls++;
            throw new Error("Injected authority publication failure");
          });
          const changed = await attempt(() => ${
            operation === "login"
              ? `mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)})`
              : "mutation.logoutCredentials(SERVER)"
          });
          return { mutation: changed, after: await snapshot(), calls };
        `,
          { xdg: "b" },
        );
        expect(result.mutation).toMatchObject({
          ok: false,
          message: "Injected authority publication failure",
        });
        expect(result.calls).toBe(1);
        expectMissing(result.after);
        expectFileAuthority(fixture, fixture.credentials("a"));
        // The unpublished destination/surviving stale keychain still exists.
        const raw = JSON.parse(
          readFileSync(fixture.keychain, "utf8"),
        ) as Record<string, string>;
        expect(JSON.parse(raw[SERVER] ?? "null")).toEqual(
          operation === "login" ? nextLogin : oldKeychain,
        );
        for (const xdg of ["a", "b"] as const) {
          expectMissing(await fixture.read({ xdg }));
          expectMissing(await fixture.read({ xdg, fileOnly: true }));
        }
        expect(fixture.exchanges()).toHaveLength(0);
        // A later explicit login can recover; failed publication is not success.
        await fixture.login(nextLogin, { xdg: "b" });
        expectFresh(
          await fixture.read(),
          nextLogin.access_token,
          nextLogin.refresh_token ?? "",
        );
      });
    },
    TEST_TIMEOUT,
  );
}

for (const operation of ["login", "logout"] as const) {
  test(
    `${operation} active-file retirement failure retains the selected source and fails closed if it disappears`,
    async () => {
      await withFixture(async (fixture) => {
        await seedPublishedFallback(fixture, activeFallback);
        const result = await fixture.run<{
          mutation: MutationResult;
          after: Snapshot;
          calls: number;
        }>(
          `
          let calls = 0;
          const original = fs.renameSync;
          spyOn(fs, "renameSync").mockImplementation((from, to) => {
            if (to === ${quoted(fixture.credentials("a"))}) {
              calls++;
              throw new Error("Injected active-file retirement failure");
            }
            return original(from, to);
          });
          const changed = await attempt(() => ${
            operation === "login"
              ? `mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)})`
              : "mutation.logoutCredentials(SERVER)"
          });
          return { mutation: changed, after: await snapshot(), calls };
        `,
          { xdg: "b" },
        );
        expect(result.mutation).toMatchObject({
          ok: false,
          message: "Injected active-file retirement failure",
        });
        expect(result.calls).toBe(1);
        expectFresh(
          result.after,
          activeFallback.access_token,
          activeFallback.refresh_token ?? "",
        );
        expectFileAuthority(fixture, fixture.credentials("a"));
        // Failure has not switched authority, even if keychainSet ran already.
        expectFresh(
          await fixture.read(),
          activeFallback.access_token,
          activeFallback.refresh_token ?? "",
        );
        rmSync(fixture.credentials("a"));
        for (const xdg of ["a", "b"] as const) {
          expectMissing(await fixture.read({ xdg }));
        }
        expect(fixture.exchanges()).toHaveLength(0);
      });
    },
    TEST_TIMEOUT,
  );
}

test(
  "a failed login destination write neither reports success nor revives private XDG or keychain credentials",
  async () => {
    await withFixture(async (fixture) => {
      const privateB = {
        access_token: "private-b",
        refresh_token: "private-b-refresh",
      };
      await fixture.login(privateB, { xdg: "b", fileOnly: true });
      await seedPublishedFallback(fixture, activeFallback);
      fixture.fail("set", true);
      const result = await fixture.run<{
        mutation: MutationResult;
        after: Snapshot;
        calls: number;
      }>(
        `
        let calls = 0;
        const original = fs.writeFileSync;
        spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
          if (typeof path === "string" && path.startsWith(${quoted(`${fixture.credentials("b")}.`)}) && path.endsWith(".tmp")) {
            calls++;
            throw new Error("Injected destination file write failure");
          }
          return original(path, ...args);
        });
        const changed = await attempt(() => mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)}));
        return { mutation: changed, after: await snapshot(), calls };
      `,
        { xdg: "b" },
      );
      expect(result.mutation).toMatchObject({
        ok: false,
        message: "Injected destination file write failure",
      });
      expect(result.calls).toBe(1);
      expectFresh(
        result.after,
        activeFallback.access_token,
        activeFallback.refresh_token ?? "",
      );
      expectFileAuthority(fixture, fixture.credentials("a"));
      expectFresh(
        await fixture.read({ xdg: "b", fileOnly: true }),
        privateB.access_token,
        privateB.refresh_token,
      );
      rmSync(fixture.credentials("a"));
      for (const xdg of ["a", "b"] as const) {
        expectMissing(await fixture.read({ xdg }));
      }
      expect(fixture.exchanges()).toHaveLength(0);
    });
  },
  TEST_TIMEOUT,
);

test(
  "rotated keychain refresh cannot report success or replay its consumed token when fallback publication fails",
  async () => {
    await withFixture(async (fixture) => {
      await fixture.login(expired);
      fixture.fail("set", true);
      const result = await fixture.run<{
        first: AccessResult;
        proactive: AccessResult;
        reactive: AccessResult;
        after: Pick<Snapshot, "read" | "stored">;
        fresh: Snapshot;
        publications: number;
      }>(
        `
        let publications = 0;
        const publication = spyOn(authority, "publishCredentialAuthority").mockImplementation(() => {
          publications++;
          throw new Error("Injected refresh authority publication failure");
        });
        const first = await access();
        const after = stored();
        const proactive = await access();
        const reactive = await access(true);
        publication.mockRestore();
        await mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)});
        return { first, proactive, reactive, after, fresh: await snapshot(), publications };
      `,
      );
      for (const access of [result.first, result.proactive, result.reactive]) {
        expect(access).toMatchObject({
          ok: false,
          name: "ReLoginRequiredError",
        });
      }
      expect(result.publications).toBeGreaterThan(0);
      // The fallback was saved, but publication failed. Never choose that
      // alternate backend merely because the selected keychain is stale.
      expect(result.after.read).toEqual({ status: "found", tokens: expired });
      expect(result.after.stored).toEqual(expired);
      expectFresh(
        result.fresh,
        nextLogin.access_token,
        nextLogin.refresh_token ?? "",
      );
      expect(
        fixture
          .exchanges()
          .map(({ refreshToken, accepted }) => ({ refreshToken, accepted })),
      ).toEqual([{ refreshToken: "refresh-0", accepted: true }]);
    });
  },
  TEST_TIMEOUT,
);

for (const source of ["file-only", "keychain"] as const) {
  for (const outcome of ["rotation", "rejection"] as const) {
    test(
      `${source} ${outcome} remains terminal in the same process when every destination file write fails`,
      async () => {
        await withFixture(async (fixture) => {
          await fixture.login(expired, { fileOnly: source === "file-only" });
          if (source === "keychain") fixture.fail("set", true);
          if (outcome === "rejection")
            fixture.setServerToken("revoked-by-server");
          const result = await fixture.run<{
            first: AccessResult;
            proactive: AccessResult;
            reactive: AccessResult;
            afterRestore: AccessResult;
            after: Pick<Snapshot, "read" | "stored">;
            fresh: Snapshot;
            writes: number;
          }>(
            `
            let writes = 0;
            const original = fs.writeFileSync;
            const failure = spyOn(fs, "writeFileSync").mockImplementation((path, ...args) => {
              if (typeof path === "string" && path.startsWith(${quoted(`${fixture.credentials("a")}.`)}) && path.endsWith(".tmp")) {
                writes++;
                throw new Error("Injected all destination file writes failure");
              }
              return original(path, ...args);
            });
            const first = await access();
            const after = stored();
            const proactive = await access();
            const reactive = await access(true);
            failure.mockRestore();
            const afterRestore = await access(true);
            await mutation.persistLoginTokens(SERVER, ${quoted(nextLogin)});
            return { first, proactive, reactive, afterRestore, after,
              fresh: await snapshot(), writes };
          `,
            { fileOnly: source === "file-only" },
          );
          for (const access of [
            result.first,
            result.proactive,
            result.reactive,
            result.afterRestore,
          ]) {
            expect(access).toMatchObject({
              ok: false,
              name: "ReLoginRequiredError",
            });
          }
          expect(result.writes).toBeGreaterThan(0);
          expect(result.after.read).toEqual({
            status: "found",
            tokens: expired,
          });
          expect(result.after.stored).toEqual(expired);
          expectFresh(
            result.fresh,
            nextLogin.access_token,
            nextLogin.refresh_token ?? "",
          );
          // No cross-process recovery promise when every durable write failed.
          // What we can guarantee is no replay by this still-running process.
          expect(
            fixture.exchanges().map(({ refreshToken, accepted }) => ({
              refreshToken,
              accepted,
            })),
          ).toEqual([
            { refreshToken: "refresh-0", accepted: outcome === "rotation" },
          ]);
        });
      },
      TEST_TIMEOUT,
    );
  }
}
