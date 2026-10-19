/** Real-process mutation races; fake OAuth/keychain only, no external services. */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalCredentialPath,
  credentialAuthorityPath,
  publishCredentialAuthority,
  readCredentialAuthority,
} from "./credential-authority.ts";
import {
  logoutCredentials,
  persistLoginTokens,
  withCredentialMutation,
} from "./credential-mutation.ts";
import * as creds from "./credentials.ts";
import { getCredentialLockPath } from "./credentials.ts";
import * as keychain from "./keychain.ts";

const SERVER = "https://credential-race.example.com";
const modulePath = (name: string) => new URL(name, import.meta.url).pathname;

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function withFakeKeychain(
  action: (fixture: {
    root: string;
    file: string;
    keychainValue?: string;
    failSet: boolean;
  }) => Promise<void>,
): Promise<void> {
  const root = canonicalCredentialPath(
    mkdtempSync(join(tmpdir(), "me-recovery-")),
  );
  const saved = Object.fromEntries(
    ["HOME", "XDG_CONFIG_HOME", "ME_NO_KEYCHAIN", "ME_SESSION_TOKEN"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  process.env.ME_NO_KEYCHAIN = "0";
  delete process.env.ME_SESSION_TOKEN;
  const fixture = {
    root,
    file: creds.getCredentialsPath(),
    keychainValue: undefined as string | undefined,
    failSet: false,
  };
  const available = spyOn(keychain, "keychainAvailable").mockReturnValue(true);
  const read = spyOn(keychain, "keychainRead").mockImplementation(() =>
    fixture.keychainValue === undefined
      ? { status: "missing" }
      : { status: "found", value: fixture.keychainValue },
  );
  const set = spyOn(keychain, "keychainSet").mockImplementation(
    (_origin, value) => {
      if (fixture.failSet) return false;
      fixture.keychainValue = value;
      return true;
    },
  );
  const del = spyOn(keychain, "keychainDelete").mockImplementation(() => {
    fixture.keychainValue = undefined;
  });
  try {
    await action(fixture);
  } finally {
    for (const spy of [available, read, set, del]) spy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

for (const operation of ["login", "logout"] as const) {
  for (const active of [true, false]) {
    test(`explicit ${operation} refuses to abandon a readable ${active ? "active" : "private"} credential file whose lock cannot be created`, async () => {
      await withFakeKeychain(async (fixture) => {
        await persistLoginTokens(SERVER, {
          access_token: "keychain-old",
          refresh_token: "keychain-r",
        });
        const path = active
          ? join(fixture.root, "other", "credentials.yaml")
          : fixture.file;
        mkdirSync(join(path, ".."), { recursive: true });
        const contents = JSON.stringify({
          servers: {
            [SERVER]: {
              tokens: { access_token: "file-old", refresh_token: "file-r" },
            },
          },
        });
        writeFileSync(path, contents);
        if (active)
          publishCredentialAuthority(SERVER, {
            version: 1,
            source: "file",
            path,
          });
        const before = readCredentialAuthority(SERVER);
        const oldKeychain = fixture.keychainValue;
        const original = fs.mkdirSync;
        const denied = spyOn(fs, "mkdirSync").mockImplementation(
          (value, options) => {
            if (String(value) === `${path}.lock`)
              throw Object.assign(new Error("read-only directory"), {
                code: "EACCES",
              });
            return original(value, options);
          },
        );
        try {
          const mutation =
            operation === "login"
              ? persistLoginTokens(SERVER, {
                  access_token: "new-login",
                  refresh_token: "new-r",
                })
              : logoutCredentials(SERVER);
          await expect(mutation).rejects.toThrow(
            "readable but cannot be locked",
          );
          expect(readCredentialAuthority(SERVER)).toEqual(before);
          expect(readFileSync(path, "utf-8")).toBe(contents);
          expect(fixture.keychainValue).toBe(oldKeychain);
        } finally {
          denied.mockRestore();
        }
      });
    });
  }
}

for (const badAuthority of [
  "corrupt",
  "unknown-version",
  "unreadable",
  "unreachable-file",
] as const) {
  for (const operation of ["login", "logout"] as const) {
    test(`explicit keychain ${operation} replaces ${badAuthority} authority; background fails closed`, async () => {
      await withFakeKeychain(async (fixture) => {
        const authority = credentialAuthorityPath(SERVER);
        mkdirSync(join(process.env.HOME as string, ".config", "me"), {
          recursive: true,
        });
        fixture.keychainValue = JSON.stringify({
          access_token: "stale-keychain",
        });
        let metadata = "not-json";
        if (badAuthority === "unknown-version")
          metadata = JSON.stringify({ version: 2, source: "keychain" });
        if (badAuthority === "unreachable-file") {
          const blocker = join(fixture.root, "not-a-directory");
          writeFileSync(blocker, "untouched");
          metadata = JSON.stringify({
            version: 1,
            source: "file",
            path: join(blocker, "credentials.yaml"),
          });
        }
        if (badAuthority === "unreadable")
          metadata = JSON.stringify({ version: 1, source: "keychain" });
        writeFileSync(authority, metadata);
        if (badAuthority === "unreadable") chmodSync(authority, 0);
        expect(creds.readStoredTokens(SERVER)).toEqual({
          status: "unavailable",
        });
        await expect(
          withCredentialMutation(SERVER, async () => {
            throw new Error("background must not run");
          }),
        ).rejects.toThrow("Credential authority cannot be read");
        if (operation === "login")
          await persistLoginTokens(SERVER, { access_token: "new-login" });
        else await logoutCredentials(SERVER);
        expect(readCredentialAuthority(SERVER)).toEqual({
          status: "found",
          authority: {
            version: 1,
            source: operation === "login" ? "keychain" : "logged_out",
          },
        });
        expect(creds.readStoredTokens(SERVER)).toEqual(
          operation === "login"
            ? { status: "found", tokens: { access_token: "new-login" } }
            : { status: "missing" },
        );
        expect(existsSync(fixture.file)).toBe(false);
      });
    });
  }
}

for (const active of [false, true]) {
  for (const operation of ["login", "logout"] as const) {
    test(`explicit keychain ${operation} leaves corrupt ${active ? "active" : "non-authoritative"} private file untouched`, async () => {
      await withFakeKeychain(async (fixture) => {
        mkdirSync(join(fixture.root, "xdg", "me"), { recursive: true });
        const corrupt = "servers: [unterminated";
        writeFileSync(fixture.file, corrupt);
        fixture.keychainValue = JSON.stringify({ access_token: "old" });
        publishCredentialAuthority(
          SERVER,
          active
            ? { version: 1, source: "file", path: fixture.file }
            : { version: 1, source: "keychain" },
        );
        if (operation === "login")
          await persistLoginTokens(SERVER, { access_token: "new" });
        else await logoutCredentials(SERVER);
        expect(readFileSync(fixture.file, "utf8")).toBe(corrupt);
        expect(readCredentialAuthority(SERVER)).toEqual({
          status: "found",
          authority: {
            version: 1,
            source: operation === "login" ? "keychain" : "logged_out",
          },
        });
      });
    });
  }
}

for (const failSet of [false, true]) {
  test(`explicit login ${failSet ? "refuses unlocked fallback if keychain fails" : "recovers an inaccessible fallback lock"}`, async () => {
    await withFakeKeychain(async (fixture) => {
      fixture.failSet = failSet;
      publishCredentialAuthority(SERVER, {
        version: 1,
        source: "file",
        path: fixture.file,
      });
      const mkdir = fs.mkdirSync;
      const inaccessible = spyOn(fs, "mkdirSync").mockImplementation(
        (...args: Parameters<typeof mkdir>) => {
          if (String(args[0]) === `${fixture.file}.lock`)
            throw Object.assign(new Error("private lock inaccessible"), {
              code: "EACCES",
            });
          return mkdir(...args);
        },
      );
      try {
        if (failSet)
          await expect(
            persistLoginTokens(SERVER, { access_token: "new" }),
          ).rejects.toThrow("fallback cannot be locked");
        else await persistLoginTokens(SERVER, { access_token: "new" });
        expect(existsSync(fixture.file)).toBe(false);
        expect(readCredentialAuthority(SERVER)).toEqual({
          status: "found",
          authority: failSet
            ? { version: 1, source: "file", path: fixture.file }
            : { version: 1, source: "keychain" },
        });
      } finally {
        inaccessible.mockRestore();
      }
    });
  });
}

for (const operation of ["login", "logout"] as const) {
  test(`explicit ${operation} does not skip a live file lock timeout`, async () => {
    await withFakeKeychain(async (fixture) => {
      publishCredentialAuthority(SERVER, { version: 1, source: "keychain" });
      const lock = `${fixture.file}.lock`;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner"), "live-peer");
      const now = Date.now();
      fs.utimesSync(lock, new Date(now + 120_000), new Date(now + 120_000));
      let calls = 0;
      const clock = spyOn(Date, "now").mockImplementation(
        () => now + (calls++ === 0 ? 0 : 45_001),
      );
      try {
        await expect(
          operation === "login"
            ? persistLoginTokens(SERVER, { access_token: "new" })
            : logoutCredentials(SERVER),
        ).rejects.toThrow("busy");
        expect(readFileSync(join(lock, "owner"), "utf8")).toBe("live-peer");
        expect(readCredentialAuthority(SERVER)).toEqual({
          status: "found",
          authority: { version: 1, source: "keychain" },
        });
      } finally {
        clock.mockRestore();
      }
    });
  });
}

for (const existing of [
  "private-login",
  "unpublished-rotation",
  "malformed",
  "corrupt",
] as const) {
  test(`background keychain failure preserves ${existing} file instead of writing a tombstone`, async () => {
    await withFakeKeychain(async (fixture) => {
      fixture.failSet = true;
      publishCredentialAuthority(SERVER, { version: 1, source: "keychain" });
      mkdirSync(join(fixture.root, "xdg", "me"), { recursive: true });
      const contents =
        existing === "corrupt"
          ? "servers: [unterminated"
          : JSON.stringify({
              servers: {
                [SERVER]:
                  existing === "malformed"
                    ? { tokens: null }
                    : {
                        tokens: {
                          access_token: existing,
                          refresh_token: `${existing}-refresh`,
                        },
                      },
                "https://other.example.com": {
                  tokens: { access_token: "other-origin" },
                },
              },
            });
      writeFileSync(fixture.file, contents);
      await expect(
        withCredentialMutation(SERVER, async (context) => {
          context.writeCurrent({
            access_token: "old-access",
            refresh_rejected: "hash-of-old-refresh",
          });
        }),
      ).rejects.toThrow("different or unreadable");
      expect(readFileSync(fixture.file, "utf8")).toBe(contents);
      expect(readCredentialAuthority(SERVER)).toEqual({
        status: "found",
        authority: { version: 1, source: "keychain" },
      });
    });
  });
}

test("background keychain demotion accepts only an identical unpublished retry", async () => {
  await withFakeKeychain(async (fixture) => {
    fixture.failSet = true;
    const tokens = { access_token: "new", refresh_token: "new-refresh" };
    mkdirSync(join(fixture.root, "xdg", "me"), { recursive: true });
    writeFileSync(
      fixture.file,
      JSON.stringify({ servers: { [SERVER]: { tokens } } }),
    );
    publishCredentialAuthority(SERVER, { version: 1, source: "keychain" });
    await withCredentialMutation(SERVER, async (context) =>
      context.writeCurrent(tokens),
    );
    expect(creds.getStoredTokens(SERVER)).toEqual(tokens);
    expect(readCredentialAuthority(SERVER)).toEqual({
      status: "found",
      authority: { version: 1, source: "file", path: fixture.file },
    });
  });
});

test("healthy keychain login recovers with an unreachable current XDG and warns about its unsaved default", async () => {
  await withFakeKeychain(async (fixture) => {
    const blocker = join(fixture.root, "blocked-xdg");
    writeFileSync(blocker, "not-a-directory");
    process.env.XDG_CONFIG_HOME = blocker;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await persistLoginTokens(SERVER, { access_token: "recovered" });
      expect(creds.readStoredTokens(SERVER)).toEqual({
        status: "found",
        tokens: { access_token: "recovered" },
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("default server could not be updated"),
      );
      expect(readFileSync(blocker, "utf8")).toBe("not-a-directory");
      await logoutCredentials(SERVER);
      expect(creds.readStoredTokens(SERVER)).toEqual({ status: "missing" });
    } finally {
      warning.mockRestore();
    }
  });
});

test("unwritable canonical HOME fails with repair guidance, not a login-again loop", async () => {
  await withFakeKeychain(async (fixture) => {
    mkdirSync(process.env.HOME as string, { recursive: true });
    writeFileSync(join(process.env.HOME as string, ".config"), "blocked");
    await expect(
      persistLoginTokens(SERVER, { access_token: "never-saved" }),
    ).rejects.toThrow("Restore write access to ~/.config/me");
    await expect(logoutCredentials(SERVER)).rejects.toThrow(
      "Restore write access to ~/.config/me",
    );
    expect(fixture.keychainValue).toBeUndefined();
  });
});

for (const operation of ["login", "logout"] as const) {
  test(`file-only explicit ${operation} refuses a corrupt file and preserves unknown other-origin content`, async () => {
    await withFakeKeychain(async (fixture) => {
      const available = spyOn(keychain, "keychainAvailable").mockReturnValue(
        false,
      );
      mkdirSync(join(fixture.root, "xdg", "me"), { recursive: true });
      const corrupt = "servers: [unterminated\nunknown-other-origin-secret";
      writeFileSync(fixture.file, corrupt);
      try {
        await expect(
          operation === "login"
            ? persistLoginTokens(SERVER, { access_token: "new" })
            : logoutCredentials(SERVER),
        ).rejects.toThrow("cannot be read");
        expect(readFileSync(fixture.file, "utf8")).toBe(corrupt);
      } finally {
        available.mockRestore();
      }
    });
  });
}

test("a readable active fallback that fails retirement is not replaced by keychain authority", async () => {
  await withFakeKeychain(async (fixture) => {
    mkdirSync(join(fixture.root, "xdg", "me"), { recursive: true });
    const contents = JSON.stringify({
      servers: { [SERVER]: { tokens: { access_token: "active-old" } } },
    });
    writeFileSync(fixture.file, contents);
    publishCredentialAuthority(SERVER, {
      version: 1,
      source: "file",
      path: fixture.file,
    });
    const rename = fs.renameSync;
    const inaccessible = spyOn(fs, "renameSync").mockImplementation(
      (...args: Parameters<typeof rename>) => {
        if (String(args[1]) === fixture.file)
          throw Object.assign(new Error("retirement failed"), {
            code: "EACCES",
          });
        return rename(...args);
      },
    );
    try {
      await expect(
        persistLoginTokens(SERVER, { access_token: "new-keychain" }),
      ).rejects.toThrow("retirement failed");
      expect(readFileSync(fixture.file, "utf8")).toBe(contents);
      expect(creds.readStoredTokens(SERVER)).toEqual({
        status: "found",
        tokens: { access_token: "active-old" },
      });
      expect(readCredentialAuthority(SERVER)).toEqual({
        status: "found",
        authority: { version: 1, source: "file", path: fixture.file },
      });
    } finally {
      inaccessible.mockRestore();
    }
  });
});

for (const exchange of ["rejection", "rotation"] as const) {
  for (const mutation of ["login", "logout"] as const) {
    test(`a concurrent ${mutation} cannot be overwritten by ${exchange} persistence`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "me-credential-race-"));
      const ready = join(dir, "rejection-ready");
      const release = join(dir, "release-rejection");
      const requested = join(dir, "mutation-requested");
      const completed = join(dir, "mutation-completed");
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: dir,
        ME_NO_KEYCHAIN: "1",
        ME_SESSION_TOKEN: "",
      };
      const children: ReturnType<typeof Bun.spawn>[] = [];
      const spawn = (source: string) => {
        const child = Bun.spawn([process.execPath, "-e", source], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
        return child;
      };
      try {
        // Stop exactly after the exchange's token check and before its write.
        // An unlocked login/logout would complete now and be overwritten on release.
        const rejecter = spawn(`
        import { mock, spyOn } from "bun:test";
        import { existsSync, writeFileSync } from "node:fs";
        const { OAuthError } = await import(${JSON.stringify(modulePath("./oauth.ts"))});
        mock.module(${JSON.stringify(modulePath("./oauth.ts"))}, () => ({
          OAuthError,
          refreshTokens: async () => { ${exchange === "rejection" ? 'throw new OAuthError("revoked", "invalid_grant");' : 'return { accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 };'} },
        }));
        const creds = await import(${JSON.stringify(modulePath("./credentials.ts"))});
        creds.storeTokens(${JSON.stringify(SERVER)}, { access_token: "old", refresh_token: "dead", expires_at: 0 });
        const original = creds.writeCurrentTokens;
        spyOn(creds, "writeCurrentTokens").mockImplementation((server, tokens, target) => {
          if (tokens.refresh_rejected || tokens.refresh_token === "rotated-refresh") {
            writeFileSync(${JSON.stringify(ready)}, "ready");
            const deadline = Date.now() + 8000;
            while (!existsSync(${JSON.stringify(release)})) {
              if (Date.now() > deadline) throw new Error("release timeout");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
          original(server, tokens, target);
        });
        const { getAccessToken, ReLoginRequiredError } = await import(${JSON.stringify(modulePath("./session.ts"))});
        ${
          exchange === "rejection"
            ? `try { await getAccessToken(${JSON.stringify(SERVER)}); throw new Error("expected rejection"); }
        catch (error) { if (!(error instanceof ReLoginRequiredError)) throw error; }`
            : `if (await getAccessToken(${JSON.stringify(SERVER)}) !== "rotated-access") throw new Error("rotation lost");`
        }
      `);
        await waitFor(ready);
        const writer = spawn(`
        import { writeFileSync } from "node:fs";
        const { persistLoginTokens, logoutCredentials } = await import(${JSON.stringify(modulePath("./credential-mutation.ts"))});
        writeFileSync(${JSON.stringify(requested)}, "requested");
        ${
          mutation === "login"
            ? `await persistLoginTokens(${JSON.stringify(SERVER)}, { access_token: "new-login", refresh_token: "new-refresh" });`
            : `await logoutCredentials(${JSON.stringify(SERVER)});`
        }
        writeFileSync(${JSON.stringify(completed)}, "completed");
      `);
        await waitFor(requested);
        await Bun.sleep(100);
        expect(existsSync(completed)).toBe(false);
        writeFileSync(release, "release");
        for (const child of [rejecter, writer]) {
          const exitCode = await child.exited;
          expect({
            exitCode,
            stderr: await new Response(child.stderr).text(),
          }).toEqual({ exitCode: 0, stderr: "" });
        }
        // Read through a third process, avoiding the parent's credential env.
        const reader = spawn(`
        import { getStoredTokens } from ${JSON.stringify(modulePath("./credentials.ts"))};
        console.log(JSON.stringify(getStoredTokens(${JSON.stringify(SERVER)}) ?? null));
      `);
        expect(await reader.exited).toBe(0);
        const stored = JSON.parse(await new Response(reader.stdout).text());
        expect(stored).toEqual(
          mutation === "login"
            ? { access_token: "new-login", refresh_token: "new-refresh" }
            : null,
        );
      } finally {
        for (const child of children) child.kill();
        await Promise.all(children.map((child) => child.exited));
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
}

test("keychain lock identity is independent of XDG; file-only lock identity remains isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "me-lock-identity-"));
  const saved = process.env.XDG_CONFIG_HOME;
  // Availability is mocked: never invoke a real keychain. No lock is acquired.
  const available = spyOn(keychain, "keychainAvailable").mockReturnValue(true);
  try {
    process.env.XDG_CONFIG_HOME = join(dir, "a");
    const keychainA = getCredentialLockPath("identity-test.lock", false);
    expect(keychainA).toBe(
      join(homedir(), ".config", "me", "identity-test.lock"),
    );
    process.env.XDG_CONFIG_HOME = join(dir, "b");
    expect(getCredentialLockPath("identity-test.lock", false)).toBe(keychainA);
    available.mockReturnValue(false);
    const scopeOnly = getCredentialLockPath("identity-test.lock", false);
    expect(scopeOnly).toBe(join(dir, "b", "me", "identity-test.lock"));
    expect(existsSync(join(dir, "b", "me"))).toBe(false);
    const fileB = getCredentialLockPath("identity-test.lock");
    process.env.XDG_CONFIG_HOME = join(dir, "a");
    expect(getCredentialLockPath("identity-test.lock")).not.toBe(fileB);
  } finally {
    available.mockRestore();
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic account-scoped stale-401 handling cannot clear a newer login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "me-stale-401-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { persistLoginTokens } from ${JSON.stringify(modulePath("./credential-mutation.ts"))};
      import { handleError } from ${JSON.stringify(modulePath("./util.ts"))};
      import { RpcError } from ${JSON.stringify(modulePath("./client.ts"))};
      // The failed request used an old token; a new login completed before its
      // error handler ran. ResolvedCredentials carries no request-token snapshot.
      await persistLoginTokens(${JSON.stringify(SERVER)}, { access_token: "new-login" });
      handleError(new RpcError(-32000, "unauthorized", { code: "UNAUTHORIZED" }), "json",
        { creds: { server: ${JSON.stringify(SERVER)}, loggedIn: true }, scope: "account" });
    `,
      ],
      {
        env: { ...process.env, XDG_CONFIG_HOME: dir, ME_NO_KEYCHAIN: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(1);
    expect(readFileSync(join(dir, "me", "credentials.yaml"), "utf8")).toContain(
      "new-login",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
