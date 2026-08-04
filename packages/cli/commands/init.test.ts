import { expect, test } from "bun:test";
import { validateInitServer } from "./init.ts";

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
});
