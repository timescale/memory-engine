import { expect, test } from "bun:test";
import { buildInitProfile, validateInitServer } from "./init.ts";

test("me init server flags require absolute http(s) URLs", () => {
  expect(validateInitServer("https://api.memory.build", "--mcp-server")).toBe(
    "https://api.memory.build",
  );
  expect(() => validateInitServer("api.memory.build", "--mcp-server")).toThrow(
    "absolute http(s) URL",
  );
  expect(() => validateInitServer("ftp://example.com", "--cli-server")).toThrow(
    "must use http(s)",
  );
  expect(() =>
    validateInitServer("https://user:password@example.com", "--mcp-server"),
  ).toThrow("must not include credentials");
  expect(() =>
    validateInitServer("https://api.memory.build/v1", "--mcp-server"),
  ).toThrow("must be a server origin");
  expect(validateInitServer("https://api.memory.build/", "--mcp-server")).toBe(
    "https://api.memory.build",
  );
});

test("me init trims capture trees before writing profiles", () => {
  expect(
    buildInitProfile(
      { kind: "directory", directory: "/repo" },
      {
        mcpHarness: [],
        captureHarness: ["claude"],
        captureServer: "https://api.memory.build",
        captureSpace: "abc123def456",
        captureTree: " /share/projects/demo ",
        cliHarness: [],
      },
    ).capture,
  ).toMatchObject({ tree: "/share/projects/demo" });
});

test("me init flag profiles explicitly disable omitted surfaces", () => {
  expect(
    buildInitProfile(
      { kind: "directory", directory: "/repo" },
      {
        mcpHarness: ["claude"],
        mcpServer: "https://api.memory.build",
        captureHarness: [],
        cliHarness: [],
      },
    ),
  ).toEqual({
    mcp: {
      enabled: true,
      server: "https://api.memory.build",
      harnesses: { claude: true },
    },
    capture: { enabled: false, harnesses: {} },
    cli: { harnesses: {} },
  });
});

test("me init validates capture scope in flag profiles", () => {
  expect(() =>
    buildInitProfile(
      { kind: "defaults" },
      {
        mcpHarness: [],
        captureHarness: ["codex"],
        captureServer: "https://api.memory.build",
        captureSpace: "abc123def456",
        captureTree: "/share/projects/demo",
        cliHarness: [],
      },
    ),
  ).toThrow("--capture-tree is only valid for a directory profile");
});
