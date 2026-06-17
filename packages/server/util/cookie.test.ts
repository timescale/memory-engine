import { describe, expect, test } from "bun:test";
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionCookieName,
} from "./cookie";

describe("sessionCookieName", () => {
  test("uses the __Host- prefix when secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-me_session");
  });
  test("uses the unprefixed name when not secure (local http)", () => {
    expect(sessionCookieName(false)).toBe("me_session");
  });
});

describe("serializeSessionCookie", () => {
  test("secure cookie: HttpOnly, SameSite=Lax, Path=/, Secure, __Host-", () => {
    const c = serializeSessionCookie("tok123", true);
    expect(c).toContain("__Host-me_session=tok123");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Secure");
    expect(c).toMatch(/Max-Age=\d+/);
    // __Host- requires no Domain attribute.
    expect(c).not.toContain("Domain");
  });

  test("non-secure cookie omits Secure and the prefix", () => {
    const c = serializeSessionCookie("tok123", false);
    expect(c).toContain("me_session=tok123");
    expect(c).not.toContain("__Host-");
    expect(c).not.toContain("Secure");
  });
});

describe("serializeClearedSessionCookie", () => {
  test("clears with Max-Age=0", () => {
    expect(serializeClearedSessionCookie(true)).toContain("Max-Age=0");
    expect(serializeClearedSessionCookie(true)).toContain("__Host-me_session=");
  });
});

describe("readSessionCookie", () => {
  test("reads the unprefixed name", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "a=1; me_session=tok; b=2" },
    });
    expect(readSessionCookie(req)).toBe("tok");
  });

  test("reads the __Host- prefixed name", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "__Host-me_session=secure-tok" },
    });
    expect(readSessionCookie(req)).toBe("secure-tok");
  });

  test("round-trips serialize → read (secure)", () => {
    const setCookie = serializeSessionCookie("round-trip", true);
    // The Set-Cookie value's first segment is name=value.
    const nameValue = setCookie.split(";")[0] ?? "";
    const req = new Request("http://x/", { headers: { Cookie: nameValue } });
    expect(readSessionCookie(req)).toBe("round-trip");
  });

  test("returns null with no cookie / no match", () => {
    expect(readSessionCookie(new Request("http://x/"))).toBeNull();
    expect(
      readSessionCookie(
        new Request("http://x/", { headers: { Cookie: "other=1" } }),
      ),
    ).toBeNull();
  });
});
