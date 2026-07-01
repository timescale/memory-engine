/**
 * Unit tests for OpenCode hook config resolution.
 *
 * Capture itself is the import path (importTranscriptFile, tested in
 * packages/cli/importers). This file only covers resolveHookConfig —
 * bearer/space/server/tree-root/content-mode resolution from credentials + flags.
 */
import { describe, expect, test } from "bun:test";
import { type HookConfig, resolveHookConfig } from "./capture.ts";

describe("resolveHookConfig", () => {
  test("returns null when no api key and no session", () => {
    expect(
      resolveHookConfig({
        server: "https://api.memory.build",
        loggedIn: false,
        activeSpace: "eng123def456",
      }),
    ).toBeNull();
  });

  test("returns null when space is missing", () => {
    expect(
      resolveHookConfig({
        server: "https://api.memory.build",
        loggedIn: true,
        apiKey: "me.lookupid12345678.secret",
      }),
    ).toBeNull();
  });

  test("resolves a full config from an explicit api key + flags", () => {
    const cfg = resolveHookConfig(
      {
        server: "https://api.example.com",
        loggedIn: false,
        apiKey: "me.lookupid12345678.secret",
        activeSpace: "eng123def456",
      },
      { treeRoot: "share.work", fullTranscript: true },
    );
    expect(cfg).toEqual({
      apiKey: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "share.work",
      fullTranscript: true,
    } satisfies HookConfig);
  });

  test("defaults: tree root + content mode when no flags passed", () => {
    const cfg = resolveHookConfig({
      server: "https://api.example.com",
      loggedIn: false,
      apiKey: "me.lookupid12345678.secret",
      activeSpace: "eng123def456",
    });
    expect(cfg).toEqual({
      apiKey: "me.lookupid12345678.secret",
      space: "eng123def456",
      server: "https://api.example.com",
      treeRoot: "share.projects",
      fullTranscript: false,
    } satisfies HookConfig);
  });

  test("falls back to the login session when no api key (bearer resolved at send time)", () => {
    const cfg = resolveHookConfig({
      server: "https://api.example.com",
      loggedIn: true,
      activeSpace: "eng123def456",
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBeUndefined();
    expect(cfg?.server).toBe("https://api.example.com");
  });

  test("empty server falls back to the default", () => {
    const cfg = resolveHookConfig({
      server: "",
      loggedIn: true,
      activeSpace: "eng123def456",
    });
    expect(cfg?.server).toBe("https://api.memory.build");
  });

  test("treats an unsubstituted ${...} tree-root placeholder as blank", () => {
    const cfg = resolveHookConfig(
      {
        server: "https://api.example.com",
        loggedIn: true,
        activeSpace: "eng123def456",
      },
      { treeRoot: "${tree_root}" },
    );
    expect(cfg?.treeRoot).toBe("share.projects");
  });

  test("a .me projectTree (from creds) sets projectTree, keeping the default parent", () => {
    const cfg = resolveHookConfig({
      server: "https://api.example.com",
      loggedIn: true,
      activeSpace: "eng123def456",
      projectTree: "share.projects.foo",
    });
    expect(cfg?.projectTree).toBe("share.projects.foo");
    expect(cfg?.treeRoot).toBe("share.projects");
  });

  test("an explicit --tree-root flag overrides the .me projectTree", () => {
    const cfg = resolveHookConfig(
      {
        server: "https://api.example.com",
        loggedIn: true,
        activeSpace: "eng123def456",
        projectTree: "share.projects.foo",
      },
      { treeRoot: "share.work" },
    );
    expect(cfg?.treeRoot).toBe("share.work");
    expect(cfg?.projectTree).toBeUndefined();
  });
});
