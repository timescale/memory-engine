/**
 * Unit tests for the shared identity/space formatting helpers.
 */

import { describe, expect, test } from "bun:test";
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import type { ResolvedCredentials } from "./credentials.ts";
import { authLabel, authMethodOf, formatSpaceLabel } from "./identity.ts";

const space = (
  over: Partial<MemberSpaceResponse> = {},
): MemberSpaceResponse => ({
  id: "019d97a2-332a-7fbd-b6e1-86c7ec1045d0",
  slug: "6nnv8r3gz9jr",
  name: "John's Space",
  language: "en",
  admin: false,
  createdAt: "2026-06-29T21:10:19.941Z",
  updatedAt: null,
  ...over,
});

const creds = (
  over: Partial<ResolvedCredentials> = {},
): ResolvedCredentials => ({
  server: "https://api.memory.build",
  loggedIn: true,
  ...over,
});

describe("formatSpaceLabel", () => {
  test("renders name (slug) without an admin marker", () => {
    expect(formatSpaceLabel(space())).toBe("John's Space (6nnv8r3gz9jr)");
  });

  test("appends [admin] when the caller is an admin", () => {
    expect(formatSpaceLabel(space({ admin: true }))).toBe(
      "John's Space (6nnv8r3gz9jr) [admin]",
    );
  });
});

describe("authMethodOf", () => {
  test("no api key → session (OAuth/cookie)", () => {
    expect(authMethodOf(creds(), "u")).toBe("session");
  });

  test("api key + user kind → pat", () => {
    expect(authMethodOf(creds({ apiKey: "me.abc.secret" }), "u")).toBe("pat");
  });

  test("api key + agent kind → agent", () => {
    expect(authMethodOf(creds({ apiKey: "me.abc.secret" }), "a")).toBe("agent");
  });
});

describe("authLabel", () => {
  test("maps each method to its display label", () => {
    expect(authLabel("session")).toBe("session");
    expect(authLabel("pat")).toBe("api key (PAT)");
    expect(authLabel("agent")).toBe("agent key");
  });
});
