/**
 * Client-side tree-path shape shared by CLI tree input validation. The server
 * still normalizes and validates paths authoritatively.
 */
export const VALID_TREE_PATH_RE =
  /^~$|^(?:~[./]|\/)?[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
