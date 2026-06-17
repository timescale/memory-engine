import { describe, expect, test } from "bun:test";
import {
  loginNonceCookieName,
  readLoginNonceCookie,
  readSessionCookie,
  serializeClearedSessionCookies,
  serializeLoginNonceCookie,
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

describe("serializeClearedSessionCookies", () => {
  test("secure mode clears both the __Host- and plain names with Max-Age=0", () => {
    const cleared = serializeClearedSessionCookies(true);
    expect(
      cleared.some(
        (c) => c.includes("__Host-me_session=") && c.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(cleared.some((c) => c.startsWith("me_session="))).toBe(true);
  });

  test("non-secure mode clears just me_session", () => {
    const cleared = serializeClearedSessionCookies(false);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain("me_session=");
    expect(cleared[0]).toContain("Max-Age=0");
  });
});

describe("readSessionCookie (mode-aware)", () => {
  test("non-secure reads the unprefixed name", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "a=1; me_session=tok; b=2" },
    });
    expect(readSessionCookie(req, false)).toBe("tok");
  });

  test("secure reads only the __Host- name", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "__Host-me_session=secure-tok" },
    });
    expect(readSessionCookie(req, true)).toBe("secure-tok");
  });

  test("secure ignores a plain me_session (the __Host- guarantee)", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "me_session=tok" },
    });
    expect(readSessionCookie(req, true)).toBeNull();
  });

  test("round-trips serialize → read (secure)", () => {
    const setCookie = serializeSessionCookie("round-trip", true);
    const nameValue = setCookie.split(";")[0] ?? "";
    const req = new Request("http://x/", { headers: { Cookie: nameValue } });
    expect(readSessionCookie(req, true)).toBe("round-trip");
  });

  test("returns null with no cookie / no match", () => {
    expect(readSessionCookie(new Request("http://x/"), false)).toBeNull();
    expect(
      readSessionCookie(
        new Request("http://x/", { headers: { Cookie: "other=1" } }),
        false,
      ),
    ).toBeNull();
  });
});

describe("login nonce cookie", () => {
  test("name is mode-aware", () => {
    expect(loginNonceCookieName(true)).toBe("__Host-me_login");
    expect(loginNonceCookieName(false)).toBe("me_login");
  });

  test("serialize → read round-trips and is httpOnly + Lax", () => {
    const c = serializeLoginNonceCookie("nonce123", true);
    expect(c).toContain("__Host-me_login=nonce123");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    const req = new Request("http://x/", {
      headers: { Cookie: c.split(";")[0] ?? "" },
    });
    expect(readLoginNonceCookie(req, true)).toBe("nonce123");
  });

  test("secure read ignores the plain me_login name", () => {
    const req = new Request("http://x/", {
      headers: { Cookie: "me_login=nonce123" },
    });
    expect(readLoginNonceCookie(req, true)).toBeNull();
  });
});
