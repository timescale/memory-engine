import { afterAll, describe, expect, test } from "bun:test";
import {
  type BetterAuthOptions,
  createBetterAuth,
  normalizeSignupEmailDomain,
} from "./betterauth";

const options: BetterAuthOptions = {
  databaseUrl: "postgresql://postgres@127.0.0.1:1/postgres",
  authSchema: "auth_test_signup",
  baseURL: "http://localhost:3000",
  secret: "test-secret-betterauth-0123456789",
  trustedOrigins: [],
};
const restricted = createBetterAuth({
  ...options,
  signupEmailDomain: " TigerData.COM ",
});
const unrestricted = createBetterAuth(options);

afterAll(async () => {
  await restricted.pool.end();
  await unrestricted.pool.end();
});

describe("signup email domain configuration", () => {
  test("unset is unrestricted; explicit values normalize case and whitespace", () => {
    expect(normalizeSignupEmailDomain(undefined)).toBeUndefined();
    expect(normalizeSignupEmailDomain(" \tTigerData.COM\n")).toBe(
      "tigerdata.com",
    );
    expect(normalizeSignupEmailDomain("team.example.co.uk")).toBe(
      "team.example.co.uk",
    );
    expect(normalizeSignupEmailDomain("xn--bcher-kva.example")).toBe(
      "xn--bcher-kva.example",
    );
  });

  test.each([
    "",
    " \t\n",
    "https://tigerdata.com",
    "tigerdata.com/path",
    "tigerdata.com:443",
    "person@tigerdata.com",
    "tigerdata.com,example.com",
    "tigerdata.com example.com",
    "*.tigerdata.com",
    ".tigerdata.com",
    "tigerdata.com.",
    "tigerdata..com",
    "tiger_data.com",
    "-tigerdata.com",
    "tigerdata-.com",
    "tigerdata",
    "127.0.0.1",
    `${"a".repeat(64)}.com`,
    `${`${"a".repeat(63)}.`.repeat(4)}com`,
  ])("rejects invalid explicit configuration %j before opening a pool", (domain) => {
    expect(() =>
      createBetterAuth({ ...options, signupEmailDomain: domain }),
    ).toThrow("SIGNUP_EMAIL_DOMAIN");
  });
});

function beforeCreate(
  instance: ReturnType<typeof createBetterAuth>,
  email: string,
  emailVerified: boolean,
) {
  const hook = instance.auth.options.databaseHooks?.user?.create?.before;
  if (!hook) throw new Error("missing user-create hook");
  return hook({
    id: "unused",
    name: "Test User",
    email,
    emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("new-user signup hook", () => {
  test("accepts only the exact domain, case-insensitively", async () => {
    await expect(
      beforeCreate(restricted, "person@TIGERDATA.COM", true),
    ).resolves.toBeUndefined();
  });

  test.each([
    "person@example.com",
    "person@sub.tigerdata.com",
    "person@eviltigerdata.com",
    "person@tigerdata.com.evil",
    "person@tigerdata.com@evil.com",
    "person@evil.com@tigerdata.com",
    "@tigerdata.com",
    "person@tigerdata.com ",
  ])("rejects %s with the callback-safe domain token", async (email) => {
    await expect(beforeCreate(restricted, email, true)).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: {
        code: "SIGNUP_RESTRICTED",
        message: "SIGNUP_RESTRICTED:tigerdata.com",
      },
    });
  });

  test("requires a verified email at the allowed domain", async () => {
    await expect(
      beforeCreate(restricted, "person@tigerdata.com", false),
    ).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "EMAIL_NOT_VERIFIED", message: "EMAIL_NOT_VERIFIED" },
    });
  });

  test("unset leaves creation unrestricted, including the existing unverified-user behavior", async () => {
    await expect(
      beforeCreate(unrestricted, "person@example.com", true),
    ).resolves.toBeUndefined();
    await expect(
      beforeCreate(unrestricted, "person@example.com", false),
    ).resolves.toBeUndefined();
  });
});
