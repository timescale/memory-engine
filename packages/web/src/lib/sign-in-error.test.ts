import { describe, expect, test } from "bun:test";
import { clearSignInError, readSignInError } from "./sign-in-error.ts";

describe("clearSignInError", () => {
  test("leaves an error-free signed query verbatim", () => {
    const search = "?scope=openid%20offline_access&state=retry&sig=signed";
    expect(clearSignInError(search)).toBe(search);
    expect(clearSignInError("")).toBe("");
  });

  test("removes all stale errors while preserving authorization parameters", () => {
    const search =
      "?client_id=me-cli&state=retry&sig=signed&ba_param=state&ba_param=sig&error=SIGNUP_RESTRICTED%3Atigerdata.com&error_description=Denied&error=old";
    expect(clearSignInError(search)).toBe(
      "?client_id=me-cli&state=retry&sig=signed&ba_param=state&ba_param=sig",
    );
    expect(clearSignInError("?error=old&error_description=Denied")).toBe("");
  });
});

describe("readSignInError", () => {
  test.each([
    "tigerdata.com",
    "example.org",
  ])("explains the configured signup domain %s", (domain) => {
    const query = new URLSearchParams({ error: `SIGNUP_RESTRICTED:${domain}` });
    expect(readSignInError(`?${query}`)).toBe(
      `New registrations are currently limited to verified @${domain} email addresses. Existing users can continue to sign in.`,
    );
  });

  test("retains the email verification message", () => {
    expect(readSignInError("?error=EMAIL_NOT_VERIFIED")).toBe(
      "Your email is not verified with your identity provider. Verify it with GitHub or Google, then sign in again.",
    );
  });

  test("prefers the server's human description", () => {
    expect(
      readSignInError(
        "?error=other&error_description=Please+verify+your+email.",
      ),
    ).toBe("Please verify your email.");
  });

  test.each(["", "?state=unused", "?error="])("no error in %j", (search) => {
    expect(readSignInError(search)).toBeNull();
  });

  test.each(["unknown", "SIGNUP_RESTRICTED:"])("falls back for %s", (error) => {
    expect(readSignInError(`?${new URLSearchParams({ error })}`)).toBe(
      "Sign-in failed. Please try again.",
    );
  });
});
