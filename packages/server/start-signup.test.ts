import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type StartServerOptions, startServer } from "./start";

// No database is used: pools are lazy, migrations/workers/cleanup are disabled.
const options: StartServerOptions = {
  port: 0,
  databaseUrl: "postgresql://postgres@127.0.0.1:1/postgres",
  apiBaseUrl: "http://localhost:3000",
  betterAuthSecret: "test-secret-betterauth-0123456789",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    apiKey: "test-key-not-used",
  },
  migrate: false,
  workerCount: 0,
  enableCleanupCron: false,
};

describe("startServer signup configuration", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.SIGNUP_EMAIL_DOMAIN;
    delete process.env.SIGNUP_EMAIL_DOMAIN;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SIGNUP_EMAIL_DOMAIN;
    else process.env.SIGNUP_EMAIL_DOMAIN = previous;
  });

  test.each([
    "",
    " \t",
    "https://tigerdata.com",
    "a@tigerdata.com",
    "tigerdata.com,example.com",
    "*.tigerdata.com",
  ])("rejects invalid SIGNUP_EMAIL_DOMAIN %j before migrations", async (domain) => {
    process.env.SIGNUP_EMAIL_DOMAIN = domain;
    await expect(startServer({ ...options, migrate: true })).rejects.toThrow(
      "SIGNUP_EMAIL_DOMAIN",
    );
  });

  test("an explicit empty option is not replaced by a valid environment value", async () => {
    process.env.SIGNUP_EMAIL_DOMAIN = "tigerdata.com";
    await expect(
      startServer({ ...options, signupEmailDomain: "" }),
    ).rejects.toThrow("SIGNUP_EMAIL_DOMAIN");
  });

  test.each([
    { env: undefined, option: undefined, expected: undefined },
    { env: " TigerData.COM ", option: undefined, expected: "tigerdata.com" },
    { env: "", option: " Example.COM ", expected: "example.com" },
  ])("wires environment/option signup configuration %j", async ({
    env,
    option,
    expected,
  }) => {
    if (env !== undefined) process.env.SIGNUP_EMAIL_DOMAIN = env;
    const server = await startServer({ ...options, signupEmailDomain: option });
    try {
      const hook =
        server.context.betterAuth.options.databaseHooks?.user?.create?.before;
      if (!hook) throw new Error("missing user-create hook");
      const result = hook({
        id: "unused",
        name: "Test User",
        email: "person@external.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      if (expected) {
        await expect(result).rejects.toMatchObject({
          body: {
            code: "SIGNUP_RESTRICTED",
            message: `SIGNUP_RESTRICTED:${expected}`,
          },
        });
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    } finally {
      await server.stop();
    }
  });
});
