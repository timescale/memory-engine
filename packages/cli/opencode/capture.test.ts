/** Unit tests for OpenCode profile-aware hook config resolution. */
import { describe, expect, test } from "bun:test";
import type { CaptureSurface } from "../local-config.ts";
import { resolveHookConfig } from "./capture.ts";

const profile: CaptureSurface = {
  enabled: true,
  server: "https://api.example.com",
  space: "eng123def456",
  tree: "/share/projects/widget",
  harnesses: { opencode: true },
};

describe("resolveHookConfig", () => {
  test("does not use credentials when no bearer is available", () => {
    expect(resolveHookConfig({ loggedIn: false }, profile)).toBeNull();
  });

  test("uses the selected capture profile rather than global targeting", () => {
    expect(
      resolveHookConfig(
        { loggedIn: true, apiKey: "me.lookupid12345678.secret" },
        profile,
      ),
    ).toEqual({
      apiKey: "me.lookupid12345678.secret",
      server: "https://api.example.com",
      space: "eng123def456",
      treeRoot: "",
      tree: "/share/projects/widget",
      fullTranscript: false,
    });
  });
});
