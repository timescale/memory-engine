/** Hermetic classifier coverage: only isolated children mock platform/spawn. */
import { expect, test } from "bun:test";
import type { KeychainRead } from "./keychain.ts";

const modulePath = import.meta.resolve("./keychain.ts");

type Scenario = {
  name: string;
  result?: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    exitedDueToTimeout?: boolean;
    exitedDueToMaxBuffer?: boolean;
    signalCode?: string;
  };
  throws?: boolean;
  expected: KeychainRead;
};

for (const platform of ["darwin", "linux"] as const) {
  const scenarios: Scenario[] = [
    {
      name: "found",
      result: { exitCode: 0, stdout: "oauth-secret" },
      expected: { status: "found", value: "oauth-secret" },
    },
    {
      name: "successful empty secret",
      result: { exitCode: 0 },
      expected: { status: "missing" },
    },
    {
      name: "confirmed absence",
      result: {
        exitCode: platform === "darwin" ? 44 : 1,
        stderr: platform === "darwin" ? "item not found" : "",
      },
      expected: { status: "missing" },
    },
    {
      name: "locked store",
      result: {
        exitCode: platform === "darwin" ? 51 : 1,
        stdout: "partial-secret-must-not-escape",
        stderr: "locked-store-sensitive-diagnostic",
      },
      expected: { status: "unavailable" },
    },
    {
      name: "unexpected exit status without diagnostics",
      result: { exitCode: 2 },
      expected: { status: "unavailable" },
    },
    {
      name: "other platform's missing status is unavailable",
      result: { exitCode: platform === "darwin" ? 1 : 44 },
      expected: { status: "unavailable" },
    },
    {
      name: "spawn failure",
      throws: true,
      expected: { status: "unavailable" },
    },
    {
      name: "timeout overrides missing exit status",
      result: {
        exitCode: platform === "darwin" ? 44 : 1,
        exitedDueToTimeout: true,
      },
      expected: { status: "unavailable" },
    },
    {
      name: "timeout overrides successful partial output",
      result: {
        exitCode: 0,
        stdout: "partial-secret-must-not-escape",
        exitedDueToTimeout: true,
      },
      expected: { status: "unavailable" },
    },
    {
      name: "signal termination",
      result: { exitCode: 0, signalCode: "SIGTERM" },
      expected: { status: "unavailable" },
    },
    {
      name: "truncated output",
      result: { exitCode: 0, exitedDueToMaxBuffer: true },
      expected: { status: "unavailable" },
    },
    {
      name: "platform newline behavior",
      result: { exitCode: 0, stdout: "oauth-secret\n" },
      expected: {
        status: "found",
        value: platform === "darwin" ? "oauth-secret" : "oauth-secret\n",
      },
    },
  ];

  for (const scenario of scenarios) {
    test(`keychainRead ${platform}: ${scenario.name} (and keychainGet compatibility)`, () => {
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `
          import assert from "node:assert/strict";
          Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
          delete process.env.ME_NO_KEYCHAIN;
          Bun.which = () => "/mock/secret-tool";
          const scenario = ${JSON.stringify(scenario)};
          let calls = 0;
          Bun.spawnSync = (options) => {
            calls++;
            assert.equal(options.cmd[0], ${JSON.stringify(platform === "darwin" ? "security" : "secret-tool")});
            assert.equal(options.stderr, "pipe");
            assert.equal(options.timeout, 5000);
            if (scenario.throws) throw new Error("sensitive-spawn-diagnostic");
            return {
              ...scenario.result,
              stdout: Buffer.from(scenario.result.stdout ?? ""),
              stderr: Buffer.from(scenario.result.stderr ?? ""),
            };
          };
          const {keychainRead, keychainGet, keychainAvailable} = await import(${JSON.stringify(modulePath)});
          assert.equal(keychainAvailable(), true);
          assert.deepEqual(keychainRead("https://example.test"), scenario.expected);
          assert.equal(keychainGet("https://example.test"), scenario.expected.status === "found" ? scenario.expected.value : undefined);
          assert.equal(calls, 2);
          `,
        ],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(child.stderr.toString()).toBe("");
      expect(child.stdout.toString()).toBe("");
      expect(child.exitCode).toBe(0);
    });
  }
}

for (const mode of ["disabled-1", "disabled-true", "unsupported", "no-tool"]) {
  test(`keychainRead ${mode}: missing permits file fallback without spawning`, () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `
        import assert from "node:assert/strict";
        const mode = ${JSON.stringify(mode)};
        Object.defineProperty(process, "platform", { value: mode === "unsupported" ? "win32" : "linux" });
        delete process.env.ME_NO_KEYCHAIN;
        if (mode.startsWith("disabled-")) process.env.ME_NO_KEYCHAIN = mode.slice(9);
        Bun.which = () => mode === "no-tool" ? null : "/mock/secret-tool";
        let calls = 0;
        Bun.spawnSync = () => { calls++; throw new Error("must not access OS keychain"); };
        const {keychainRead, keychainGet, keychainAvailable, keychainSet, keychainDelete} = await import(${JSON.stringify(modulePath)});
        assert.equal(keychainAvailable(), false);
        assert.deepEqual(keychainRead("acct"), {status: "missing"});
        assert.equal(keychainGet("acct"), undefined);
        assert.equal(keychainSet("acct", "secret"), false);
        keychainDelete("acct");
        assert.equal(calls, 0);
        `,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.stdout.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  });
}
