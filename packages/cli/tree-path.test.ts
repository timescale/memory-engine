import { expect, test } from "bun:test";
import { VALID_TREE_PATH_RE } from "./tree-path.ts";

test("tree path validation accepts the root path", () => {
  expect(VALID_TREE_PATH_RE.test("/")).toBe(true);
});
