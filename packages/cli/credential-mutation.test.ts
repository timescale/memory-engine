/** Real-process mutation races; fake OAuth/keychain only, no external services. */
import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
        const original = creds.storeTokens;
        spyOn(creds, "storeTokens").mockImplementation((server, tokens, options) => {
          if (tokens.refresh_rejected || tokens.refresh_token === "rotated-refresh") {
            writeFileSync(${JSON.stringify(ready)}, "ready");
            const deadline = Date.now() + 8000;
            while (!existsSync(${JSON.stringify(release)})) {
              if (Date.now() > deadline) throw new Error("release timeout");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
          original(server, tokens, options);
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
