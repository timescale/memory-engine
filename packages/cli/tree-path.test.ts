import { expect, test } from "bun:test";
import { VALID_TREE_PATH_RE } from "./tree-path.ts";

// Representative shapes accepted by the client-side gate. The server still
// normalizes/validates authoritatively; this only catches obvious typos early.
const VALID_PATHS = [
  "/", // root
  "~", // home
  "share", // bare label
  "/share", // leading-slash label
  "/share/projects/demo", // slash separators
  "share.projects.demo", // dotted (ltree) separators
  "/share/projects.demo", // mixed separators
  "~/notes", // home with slash prefix
  "~.notes", // home with dot prefix
  "~/notes/todo", // nested home path
  "home_1/sub-2", // digits, underscore, hyphen
];

const INVALID_PATHS = [
  "", // empty
  "/share/", // trailing slash
  "share/", // trailing separator
  "/share//projects", // empty segment (double slash)
  "share..projects", // empty segment (double dot)
  "~notes", // ~ not followed by a separator
  ".share", // leading separator without ~ or /
  "share.", // trailing dot
  "foo@bar", // invalid character
  "a b", // whitespace
  "//", // no label
];

test.each(VALID_PATHS)("tree path validation accepts %p", (path) => {
  expect(VALID_TREE_PATH_RE.test(path)).toBe(true);
});

test.each(INVALID_PATHS)("tree path validation rejects %p", (path) => {
  expect(VALID_TREE_PATH_RE.test(path)).toBe(false);
});
